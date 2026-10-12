export const MIN_PASSWORD_LENGTH = 14;

export interface Strength {
  score: 0 | 1 | 2 | 3;
  label: string;
}

/** Rough client-side hint only; the server checks length and a list of common passwords. */
export function passwordStrength(pw: string): Strength {
  if (pw.length < MIN_PASSWORD_LENGTH) {
    return { score: 0, label: `Trop court : au moins ${MIN_PASSWORD_LENGTH} caractères (${pw.length}/${MIN_PASSWORD_LENGTH})` };
  }
  const classes = [/[a-z]/, /[A-Z]/, /\d/, /[^A-Za-z0-9]/].filter((re) => re.test(pw)).length;
  const unique = new Set(pw).size;
  if (unique < 6) return { score: 1, label: 'Faible : trop de caractères répétés' };
  let points = 0;
  if (pw.length >= 18) points++;
  if (pw.length >= 24) points++;
  if (classes >= 3) points++;
  if (points >= 2) return { score: 3, label: 'Solide' };
  if (points === 1) return { score: 2, label: 'Correct — une phrase de passe plus longue serait encore mieux' };
  return { score: 1, label: 'Acceptable, mais allonge-le ou mélange les types de caractères' };
}
