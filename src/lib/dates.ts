/**
 * 学習日・連続日数まわりの純関数ユーティリティ。
 *
 * 「学習日」は午前3時で切り替わる（3時より前は前日の学習として扱う）。
 * すべてデバイスのローカル時刻を基準にする。
 */

const DAY_CUTOFF_HOUR = 3;

function pad2(n: number): string {
  return String(n).padStart(2, '0');
}

function formatDate(d: Date): string {
  return `${d.getFullYear()}-${pad2(d.getMonth() + 1)}-${pad2(d.getDate())}`;
}

function parseDate(s: string): Date {
  const [y, m, d] = s.split('-').map(Number);
  return new Date(y, m - 1, d);
}

function addDays(dateStr: string, delta: number): string {
  const d = parseDate(dateStr);
  d.setDate(d.getDate() + delta);
  return formatDate(d);
}

/**
 * 指定した日時に対応する「学習日」文字列 (YYYY-MM-DD) を返す。
 * 午前0:00〜2:59は前日扱いにする。
 */
export function learningDate(now: Date): string {
  const d = new Date(now.getTime());
  if (d.getHours() < DAY_CUTOFF_HOUR) {
    d.setDate(d.getDate() - 1);
  }
  return formatDate(d);
}

/**
 * 練習した学習日の一覧から、`today` を起点とした連続日数を計算する。
 *
 * - `today` に練習していればそこから遡って連続日数を数える。
 * - `today` はまだ練習していなくても、前日までが連続していればストリークは維持される
 *   （その日のうちに練習すればまだ途切れていない、という表示のため）。
 * - `today` も前日も練習していなければ 0。
 */
export function calcStreak(dates: string[], today: string): number {
  const set = new Set(dates);

  let cursor: string;
  if (set.has(today)) {
    cursor = today;
  } else {
    const yesterday = addDays(today, -1);
    if (!set.has(yesterday)) {
      return 0;
    }
    cursor = yesterday;
  }

  let streak = 0;
  while (set.has(cursor)) {
    streak++;
    cursor = addDays(cursor, -1);
  }
  return streak;
}
