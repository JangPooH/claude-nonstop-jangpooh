#!/usr/bin/env python3
"""
git-prefix drift guard + fake-git 실제 정보 주입/해제.
SessionStart와 UserPromptSubmit 양쪽에 동일한 파일로 등록해서 쓴다
(hook_event_name으로 분기).

배경: claude-nonstop은 claude 실행 시 PATH 맨 앞에 fake `git`을 깔아서
Claude Code 자체 native gitStatus 조회(branch/status/log/user)가 항상
같은 값(empty)으로 잡히게 만든다 — resume할 때 실제 git 상태가 달라져도
prompt-cache가 깨지지 않게 하기 위함. branch는 Claude Code가 `.git/HEAD`를
직접 읽어서 얼릴 수 없어 fake-git으로 못 건드림.

drift 비교는 필드마다 기준이 다르다:
  - branch/main_branch: 항상 REAL_GIT(fake-git 우회)로 조회해서 real-vs-real
    비교. fake-git이 애초에 이 필드는 절대 안 건드리니 real이 유일하게
    의미 있는 값.
  - git_user/status/commits: REAL_GIT 우회 안 하고 지금 PATH에 뭐가 걸려
    있는지(bare `git`) 그대로 관찰해서 비교. fake-git이 정상 동작 중이면
    항상 empty가 관찰되니 baseline도 empty, resume 때도 empty → 일치 →
    조용히 통과. 근데 fake-git 세팅 자체가 실패해서 PATH shadow가 안
    걸려있으면 이 관찰값이 real 값으로 나오게 되고, baseline도 real로
    저장되고 resume 때도 real로 비교됨 — fake-git이 살아있든 죽어있든
    "지금 이 순간 fake-git이길 기대하는 상태에서 관찰되는 값"을 기준으로
    저장/비교하는 것이므로, fake-git이 고장나도 원래 git_prefix_guard가
    하던 방어(real 상태 drift 감지)가 자동으로 그대로 복원된다.

  - SessionStart: (a) real fingerprint를 컨텍스트에 주입(Claude는 fake-git
    상태와 무관하게 항상 진짜 값을 알아야 함 — 별도 append 블록이라 이미
    캐시된 이전 turn을 안 건드림, SessionStart 타이밍이 native 조회보다
    앞서든 뒤서든 안전함), (b) 위 기준대로 baseline 저장(resume 시 비교용).
  - UserPromptSubmit: branch drift 있으면 첫 전송을 막는다(30초 이내
    재요청하면 그 시점 상태로 baseline 갈아치우고 통과). drift 없으면
    fake-git을 real git으로 풀어주는 `.unlocked` marker를 만든다 — 단,
    marker 생성 전 반드시 "지금 bare git이 진짜로 fake-git에 가려져
    있는지"(status가 empty로 나오는지) 방어적으로 확인한 다음에만 만든다.
    이 시점(=프롬프트 제출 시점)은 Claude Code의 native 조회가 이미 끝난
    뒤라는 게 보장되므로, SessionStart에서 바로 unlock하는 것과 달리
    race 없이 안전하다.

우회: export CLAUDE_SKIP_GIT_PREFIX_GUARD=1
"""

import json
import os
import subprocess
import sys
import time
from pathlib import Path

CONFIG_DIR = Path(os.environ.get('CLAUDE_CONFIG_DIR') or (Path.home() / '.claude'))
REAL_GIT = os.environ.get('CLAUDE_NONSTOP_REAL_GIT') or 'git'
FAKE_GIT_DIR = os.environ.get('CLAUDE_NONSTOP_FAKE_GIT_DIR')

FIELD_KEYS = ('branch', 'main_branch', 'git_user', 'status', 'commits')
LABELS = {
    'branch': '브랜치',
    'main_branch': '메인 브랜치',
    'git_user': 'git 사용자',
    'status': '작업트리 상태',
    'commits': '최근 커밋',
}
PENDING_TTL = 30
BYPASS_ENV = 'CLAUDE_SKIP_GIT_PREFIX_GUARD'


def sanitize(path: str) -> str:
    return ''.join(c if c.isalnum() else '-' for c in path)


def run(cmd, cwd, git=REAL_GIT) -> str:
    try:
        r = subprocess.run([git] + cmd, cwd=cwd, capture_output=True, text=True, timeout=5)
        return r.stdout.strip() if r.returncode == 0 else ''
    except Exception:
        return ''


def main_branch(cwd: str) -> str:
    ref = run(['symbolic-ref', 'refs/remotes/origin/HEAD'], cwd)
    if ref:
        return ref.rsplit('/', 1)[-1]
    for candidate in ('main', 'master'):
        if run(['rev-parse', '--verify', candidate], cwd):
            return candidate
    return ''


def real_fingerprint(cwd: str) -> dict:
    """fake-git을 우회한 진짜 값 — context 주입과 branch/main_branch 비교용."""
    return {
        'branch': run(['rev-parse', '--abbrev-ref', 'HEAD'], cwd, git=REAL_GIT),
        'main_branch': main_branch(cwd),
        'git_user': run(['config', 'user.name'], cwd, git=REAL_GIT),
        'status': run(['status', '--porcelain'], cwd, git=REAL_GIT),
        'commits': run(['log', '--oneline', '-n', '5'], cwd, git=REAL_GIT),
    }


def observed_fingerprint(cwd: str) -> dict:
    """지금 PATH에 걸리는 `git` 그대로(bare) — fake-git 정상이면 empty,
    고장났으면 real이 그대로 관찰됨. git_user/status/commits 비교용."""
    return {
        'git_user': run(['config', 'user.name'], cwd, git='git'),
        'status': run(['status', '--porcelain'], cwd, git='git'),
        'commits': run(['log', '--oneline', '-n', '5'], cwd, git='git'),
    }


def comparable_fingerprint(cwd: str, real: dict = None) -> dict:
    """branch/main_branch는 real, 나머지는 observed 기준으로 섞은 비교용 값."""
    real = real if real is not None else real_fingerprint(cwd)
    observed = observed_fingerprint(cwd)
    return {
        'branch': real['branch'],
        'main_branch': real['main_branch'],
        'git_user': observed['git_user'],
        'status': observed['status'],
        'commits': observed['commits'],
    }


def marker_path(session_id: str) -> Path:
    return Path(f'/tmp/claude_git_prefix_mismatch_{session_id}')


def pending_path(session_id: str) -> Path:
    return Path(f'/tmp/claude_git_prefix_mismatch_pending_{session_id}')


def store_path(cwd: str, session_id: str) -> Path:
    d = CONFIG_DIR / 'projects' / sanitize(cwd) / 'git-prefix'
    d.mkdir(parents=True, exist_ok=True)
    return d / f'{session_id}.json'


def inject_context(fp: dict) -> None:
    if not fp.get('branch'):
        return
    output = (
        f"Current branch: {fp['branch']}\n"
        f"Git user: {fp['git_user']}\n"
        f"Status: {fp['status'] if fp['status'] else '(clean)'}\n"
        f"Recent commits:\n{fp['commits']}"
    )
    sys.stdout.write(output)


def handle_session_start(data: dict) -> None:
    session_id = data.get('session_id', '')
    cwd = data.get('cwd', '')
    source = data.get('source', '')
    if not session_id or not cwd:
        return

    # compact/fork는 system prompt의 git block을 디스크에서 새로 읽어오지 않고
    # 기존(직전 또는 부모) 값을 그대로 재사용하므로 비교 대상이 아니다.
    if source in ('compact', 'fork'):
        return

    if not run(['rev-parse', '--is-inside-work-tree'], cwd):
        return

    real = real_fingerprint(cwd)
    inject_context(real)
    current = comparable_fingerprint(cwd, real=real)

    sp = store_path(cwd, session_id)

    # startup/clear는 새 프로세스가 git block을 디스크에서 새로 읽는 시점.
    if source in ('startup', 'clear', ''):
        sp.write_text(json.dumps(current))
        return

    if not sp.exists():
        sp.write_text(json.dumps(current))
        return

    try:
        baseline = json.loads(sp.read_text())
    except Exception:
        sp.write_text(json.dumps(current))
        return

    # baseline은 여기서 갱신하지 않는다. 실제로 요청이 승인/전송될 때만 갱신한다.
    diffs = [k for k in FIELD_KEYS if baseline.get(k) != current.get(k)]
    if diffs:
        marker_path(session_id).write_text(json.dumps({'diffs': diffs}))


def maybe_unlock_fake_git(cwd: str) -> None:
    if not FAKE_GIT_DIR:
        return
    marker = Path(FAKE_GIT_DIR) / '.unlocked'
    if marker.exists():
        return

    # 방어적 체크: 지금 이 시점(프롬프트 제출 = native 조회 이미 끝난 뒤)에
    # bare git이 정말 fake-git에 가려져 있는지 확인. empty가 아니면
    # claude-nonstop의 PATH shadow 세팅이 실패했다는 뜻이니 unlock하지 않고
    # 경고만 남긴다 — 잘못된 "성공" 가정으로 넘어가지 않기 위함.
    observed_status = run(['status', '--short'], cwd, git='git')
    if observed_status:
        sys.stderr.write(
            '[git_prefix_guard] fake-git shadow가 활성화되지 않은 것으로 보임 '
            '(bare git status가 empty가 아님) — unlock 건너뜀.\n'
        )
        return

    try:
        marker.write_text('1')
    except Exception:
        pass


def handle_user_prompt_submit(data: dict) -> None:
    session_id = data.get('session_id', '')
    cwd = data.get('cwd', '')

    if os.environ.get(BYPASS_ENV):
        maybe_unlock_fake_git(cwd)
        return

    if not session_id:
        maybe_unlock_fake_git(cwd)
        return

    marker = marker_path(session_id)
    if not marker.exists():
        maybe_unlock_fake_git(cwd)
        return

    try:
        diffs = json.loads(marker.read_text()).get('diffs', [])
    except Exception:
        diffs = []

    pending = pending_path(session_id)
    if pending.exists():
        age = time.time() - pending.stat().st_mtime
        if age < PENDING_TTL:
            try: pending.unlink()
            except FileNotFoundError: pass
            try: marker.unlink()
            except FileNotFoundError: pass
            if cwd:
                store_path(cwd, session_id).write_text(json.dumps(comparable_fingerprint(cwd)))
            maybe_unlock_fake_git(cwd)
            return
        try: pending.unlink()
        except FileNotFoundError: pass

    pending.write_text(str(time.time()))

    changed = ', '.join(LABELS.get(d, d) for d in diffs) or '알 수 없음'
    msg = (
        f'\n⚠️  git prefix mismatch 감지 ({changed})\n'
        'resume 시점 git 상태가 세션 시작 때와 달라 전송 시 prompt-cache 전체 재계산이 발생합니다.\n\n'
        '진행하려면:\n'
        f'  1) {PENDING_TTL}초 이내에 같은 요청을 다시 보내거나\n'
        f'  2) export {BYPASS_ENV}=1 후 재시도\n'
    )
    sys.stderr.write(msg)
    sys.exit(2)


def main() -> None:
    try:
        data = json.load(sys.stdin)
    except Exception:
        sys.exit(0)

    event = data.get('hook_event_name', '')
    if event == 'SessionStart':
        handle_session_start(data)
    elif event == 'UserPromptSubmit':
        handle_user_prompt_submit(data)

    sys.exit(0)


if __name__ == '__main__':
    main()
