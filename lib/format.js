/**
 * Shared formatting utilities for terminal status display.
 */

export function formatUserInfo({ name, email }) {
  if (name && email) return ` (${name} — ${email})`;
  if (name) return ` (${name})`;
  if (email) return ` (${email})`;
  return '';
}

export function makeBar(percent, remainingTimePercent = null, width = 25, colorMode = null) {
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

  // Auto-detect colorMode based on percent if not specified
  const DIM = '\x1b[2m';
  const RESET = '\x1b[0m';
  if (colorMode === null) {
    colorMode = getColorMode(safePercent);
  } else if (!['critical', 'warning', 'normal'].includes(colorMode)) {
    colorMode = 'normal';  // fallback for invalid colorMode
  }

  // Determine color based on colorMode
  const color = getColorCode(colorMode);

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

  // 시간 마커: colorMode에 따라 배경색 강조
  const markerBg = getMarkerBgColor(colorMode);

  // 마커 앞 구간
  const beforeFullBlocks = Math.min(fullBlocks, timePos);
  const hasPartialBeforeMarker = partialChar && timePos > fullBlocks;
  const emptyBeforeMarker = Math.max(0, timePos - visualFilled);
  let result = '';
  if (beforeFullBlocks > 0) result += `${color}${'█'.repeat(beforeFullBlocks)}${RESET}`;
  if (hasPartialBeforeMarker) result += `${color}${partialChar}${RESET}`;
  if (emptyBeforeMarker > 0) result += `${DIM}${'░'.repeat(emptyBeforeMarker)}${RESET}`;

  // 마커: filled char는 bold bright 전경색, empty char는 배경색
  const markerChar = charAt(timePos);
  const markerCode = markerChar !== '░' ? getMarkerFgColor(colorMode) : markerBg;
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

export function formatExtraCredit(extraUsage) {
  if (!extraUsage) return null;

  return {
    enabled: extraUsage.is_enabled,
    utilized: Number(extraUsage.utilization),
    usedCents: extraUsage.used_credits,
    limitCents: extraUsage.monthly_limit,
  };
}

export function getMonthlyResetTime() {
  const now = new Date();
  const nextMonth = new Date(now.getFullYear(), now.getMonth() + 1, 1, 0, 0, 0);
  return nextMonth.toISOString();
}

/**
 * Convert percent to colorMode: normal, warning, critical
 */
export function getColorMode(percent) {
  if (percent >= 90) return 'critical';
  if (percent >= 75) return 'warning';
  return 'normal';
}

/**
 * Convert colorMode to ANSI color code
 */
export function getColorCode(colorMode) {
  if (colorMode === 'critical') return '\x1b[31m';       // RED
  if (colorMode === 'warning') return '\x1b[38;5;208m';  // ORANGE
  if (colorMode === 'normal') return '\x1b[94m';         // BRIGHT_BLUE
  return '\x1b[94m';                                       // fallback: BRIGHT_BLUE
}

/**
 * Convert colorMode to marker foreground color code (for filled characters)
 */
export function getMarkerFgColor(colorMode) {
  if (colorMode === 'critical') return '\x1b[1;91m';      // bold bright red
  if (colorMode === 'warning') return '\x1b[38;5;214m';   // bright orange
  if (colorMode === 'normal') return '\x1b[1;96m';        // bold bright cyan
  return '\x1b[1;96m';                                     // fallback: bold bright cyan
}

/**
 * Convert colorMode to marker background color code (for empty characters)
 */
export function getMarkerBgColor(colorMode) {
  if (colorMode === 'critical') return '\x1b[1;30;101m';  // bold + black text + bright red bg
  if (colorMode === 'warning') return '\x1b[38;5;214m';   // bright orange (contrasts with bar's 208)
  if (colorMode === 'normal') return '\x1b[1;30;106m';    // bold + black text + bright cyan bg
  return '\x1b[1;30;106m';                                 // fallback: bright cyan bg
}

/**
 * Colorize a percentage value based on colorMode
 */
export function colorizePercent(percent, colorMode = null, padWidth = 3) {
  const RESET = '\x1b[0m';
  // Auto-detect colorMode from percent if not provided
  if (colorMode === null) {
    colorMode = getColorMode(percent);
  } else if (!['critical', 'warning', 'normal'].includes(colorMode)) {
    colorMode = 'normal';  // fallback for invalid colorMode
  }
  const color = getColorCode(colorMode);
  // Round to 2 decimal places to avoid floating point display issues
  const rounded = Math.round(percent * 100) / 100;
  return `${color}${String(rounded).padStart(padWidth)}%${RESET}`;
}
