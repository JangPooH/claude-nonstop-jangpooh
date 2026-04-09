/**
 * Shared formatting utilities for terminal status display.
 */

export function formatUserInfo({ name, email }) {
  if (name && email) return ` (${name} — ${email})`;
  if (name) return ` (${name})`;
  if (email) return ` (${email})`;
  return '';
}

export function makeBar(percent, remainingTimePercent = null, width = 25) {
  // 8단계 블록 문자: index 1~7 = ▏▎▍▌▋▊▉, index 8 = █ (fullBlock)
  const BLOCK_CHARS = ['', '▏', '▎', '▍', '▌', '▋', '▊', '▉', '█'];
  const safePercent = Math.min(100, Math.max(0, percent || 0));
  const safeWidth = Math.max(0, Math.round(width));

  // 8단계 정밀도: totalFill을 부동소수점으로 계산
  const totalFill = (safePercent / 100) * safeWidth;
  const fullBlocks = Math.floor(totalFill);
  const partialEighths = Math.floor((totalFill - fullBlocks) * 8); // 0~7
  const partialChar = partialEighths > 0 ? BLOCK_CHARS[partialEighths] : null;
  // 시각적으로 채워진 칸 수 (full + 0 or 1 partial)
  const visualFilled = fullBlocks + (partialChar ? 1 : 0);

  // usage percent 기반 색상
  const DIM = '\x1b[2m';
  const RESET = '\x1b[0m';
  let color;
  if (safePercent >= 90) color = '\x1b[31m';       // RED
  else if (safePercent >= 75) color = '\x1b[38;5;208m';  // ORANGE
  else color = '\x1b[94m';                          // BRIGHT_BLUE

  // 각 위치의 문자 반환 (마커 없이)
  function charAt(i) {
    if (i < fullBlocks) return '█';
    if (i === fullBlocks && partialChar) return partialChar;
    return '░';
  }

  // 시간 마커 계산
  const elapsedPercent = remainingTimePercent !== null
    ? 100 - Math.min(100, Math.max(0, remainingTimePercent))
    : null;
  const timePos = elapsedPercent !== null && elapsedPercent < 100
    ? Math.min(safeWidth - 1, Math.floor((elapsedPercent / 100) * safeWidth))
    : -1;

  if (timePos < 0) {
    // 마커 없음 — 구간별 렌더링
    let result = '';
    if (fullBlocks > 0) result += `${color}${'█'.repeat(fullBlocks)}${RESET}`;
    if (partialChar) result += `${color}${partialChar}${RESET}`;
    const emptyCount = safeWidth - visualFilled;
    if (emptyCount > 0) result += `${DIM}${'░'.repeat(emptyCount)}${RESET}`;
    return result;
  }

  // 시간 마커: 배경색으로 강조
  let markerBg;
  if (safePercent >= 90) markerBg = '\x1b[1;30;101m';      // bold + black text + bright red bg
  else if (safePercent >= 75) markerBg = '\x1b[38;5;214m'; // bright orange (contrasts with bar's 208)
  else markerBg = '\x1b[1;30;106m';                         // bold + black text + bright cyan bg

  // 마커 앞 구간
  const beforeFullBlocks = Math.min(fullBlocks, timePos);
  const hasPartialBeforeMarker = partialChar && timePos > fullBlocks;
  const emptyBeforeMarker = Math.max(0, timePos - visualFilled);
  let result = '';
  if (beforeFullBlocks > 0) result += `${color}${'█'.repeat(beforeFullBlocks)}${RESET}`;
  if (hasPartialBeforeMarker) result += `${color}${partialChar}${RESET}`;
  if (emptyBeforeMarker > 0) result += `${DIM}${'░'.repeat(emptyBeforeMarker)}${RESET}`;

  // 마커: █은 배경색이 가려지므로 bold bright 전경색, 그 외(partial/empty)는 배경색
  const markerChar = charAt(timePos);
  let markerCode;
  if (markerChar !== '░') {
    if (safePercent >= 90) markerCode = '\x1b[1;91m';      // bold bright red
    else if (safePercent >= 75) markerCode = '\x1b[38;5;214m'; // bright orange (contrasts with bar's 208)
    else markerCode = '\x1b[1;96m';                         // bold bright cyan
  } else {
    markerCode = markerBg;
  }
  result += `${markerCode}${markerChar}${RESET}`;

  // 마커 뒤 구간
  const afterStart = timePos + 1;
  const afterFullBlocks = Math.max(0, fullBlocks - afterStart);
  const hasPartialAfterMarker = partialChar && timePos < fullBlocks;
  const emptyAfterMarker = Math.max(0, safeWidth - Math.max(visualFilled, afterStart));
  if (afterFullBlocks > 0) result += `${color}${'█'.repeat(afterFullBlocks)}${RESET}`;
  if (hasPartialAfterMarker) result += `${color}${partialChar}${RESET}`;
  if (emptyAfterMarker > 0) result += `${DIM}${'░'.repeat(emptyAfterMarker)}${RESET}`;

  return result;
}

export function formatResetTime(isoString) {
  try {
    const date = new Date(isoString);
    const now = new Date();
    const diffMs = date.getTime() - now.getTime();

    if (diffMs <= 0) return 'now';

    const days = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];
    const day = days[date.getDay()];
    const mm = String(date.getMonth() + 1).padStart(2, '0');
    const dd = String(date.getDate()).padStart(2, '0');
    const hh = String(date.getHours()).padStart(2, '0');
    const mi = String(date.getMinutes()).padStart(2, '0');
    const dateStr = `${day} ${mm}/${dd} ${hh}:${mi}`;

    const totalHours = Math.floor(diffMs / (1000 * 60 * 60));
    const minutes = Math.floor((diffMs % (1000 * 60 * 60)) / (1000 * 60));

    let dPart, hPart;
    if (totalHours >= 24) {
      const d = Math.floor(totalHours / 24);
      const h = totalHours % 24;
      dPart = `${d}d `;
      hPart = String(h).padStart(2) + 'h';
    } else if (totalHours > 0) {
      dPart = '   ';
      hPart = String(totalHours).padStart(2) + 'h';
    } else {
      dPart = '   ';
      hPart = '   ';
    }
    const mPart = String(minutes).padStart(2) + 'm';
    const remaining = `${dPart}${hPart} ${mPart}`;
    return `in ${remaining} (${dateStr})`;
  } catch {
    return isoString;
  }
}
