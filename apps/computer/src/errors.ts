/** Error that maps to a JSON HTTP response `{ error, message }` (message in French). */
export class HttpError extends Error {
  constructor(
    public readonly status: number,
    public readonly code: string,
    message: string,
  ) {
    super(message);
  }
}

export const badRequest = (message: string): HttpError => new HttpError(400, 'bad_request', message);
export const forbidden = (message: string): HttpError => new HttpError(403, 'forbidden', message);
export const notFound = (message: string): HttpError => new HttpError(404, 'not_found', message);

/** Converts any thrown value (fs errors included) into an HttpError. */
export function toHttpError(err: unknown, subject?: string): HttpError {
  if (err instanceof HttpError) return err;
  const code = (err as NodeJS.ErrnoException | null)?.code;
  const what = subject ? ` : ${subject}` : '';
  switch (code) {
    case 'ENOENT':
      return notFound(`Fichier ou dossier introuvable${what}`);
    case 'ENOTDIR':
      return badRequest(`Un élément du chemin n'est pas un dossier${what}`);
    case 'EISDIR':
      return badRequest(`C'est un dossier, pas un fichier${what}`);
    case 'EACCES':
    case 'EPERM':
      return forbidden(`Permission refusée${what}`);
    case 'EEXIST':
      return new HttpError(409, 'conflict', `Existe déjà${what}`);
    case 'ENOSPC':
      return new HttpError(507, 'no_space', 'Plus de place sur le disque.');
    case 'ENAMETOOLONG':
      return badRequest(`Nom trop long${what}`);
    default:
      return new HttpError(500, 'internal', `Erreur interne : ${(err as Error)?.message ?? String(err)}`);
  }
}
