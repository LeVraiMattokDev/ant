/** Human-readable French description of the 5-field cron expressions Ant generates. */

const DAYS = ['dimanche', 'lundi', 'mardi', 'mercredi', 'jeudi', 'vendredi', 'samedi'];

function pad(n: number): string {
  return String(n).padStart(2, '0');
}

function isInt(v: string): boolean {
  return /^\d+$/.test(v);
}

function describeDow(dow: string): string | null {
  if (dow === '*') return null;
  if (dow === '1-5') return 'du lundi au vendredi';
  if (dow === '0,6' || dow === '6,0') return 'le week-end';
  const parts = dow.split(',');
  if (parts.every(isInt)) {
    const names = parts.map((p) => DAYS[Number(p) % 7]);
    if (names.length === 1) return `chaque ${names[0]}`;
    return `les ${names.slice(0, -1).join(', ')} et ${names[names.length - 1]}`;
  }
  const range = /^(\d)-(\d)$/.exec(dow);
  if (range) return `du ${DAYS[Number(range[1]) % 7]} au ${DAYS[Number(range[2]) % 7]}`;
  return null;
}

export function describeCron(expr: string): string {
  const fields = expr.trim().split(/\s+/);
  if (fields.length !== 5) return `Expression cron : ${expr}`;
  const [min, hour, dom, mon, dow] = fields as [string, string, string, string, string];

  const everyMin = /^\*\/(\d+)$/.exec(min);
  if (everyMin && hour === '*' && dom === '*' && mon === '*' && dow === '*') return `Toutes les ${everyMin[1]} minutes`;
  const everyHour = /^\*\/(\d+)$/.exec(hour);
  if (isInt(min) && everyHour && dom === '*' && mon === '*' && dow === '*') {
    return `Toutes les ${everyHour[1]} heures (à la minute ${pad(Number(min))})`;
  }
  if (isInt(min) && hour === '*' && dom === '*' && mon === '*' && dow === '*') return `Toutes les heures à la minute ${pad(Number(min))}`;

  if (!isInt(min)) return `Expression cron : ${expr}`;
  const hours = hour.split(',');
  if (!hours.every(isInt)) return `Expression cron : ${expr}`;
  const at = hours.map((h) => `${pad(Number(h))}:${pad(Number(min))}`).join(' et ');

  if (mon === '*' && dom === '*') {
    const d = describeDow(dow);
    if (dow === '*') return `Tous les jours à ${at}`;
    if (d) return `${d.charAt(0).toUpperCase()}${d.slice(1)} à ${at}`;
  }
  if (mon === '*' && isInt(dom) && dow === '*') return `Le ${dom === '1' ? '1er' : dom} de chaque mois à ${at}`;
  return `Expression cron : ${expr}`;
}
