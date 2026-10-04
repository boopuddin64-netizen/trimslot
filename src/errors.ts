export class AppError extends Error {
  constructor(public status: number, public code: string, message: string, public details?: unknown) {
    super(message);
  }
}
export const badRequest = (msg: string, details?: unknown) => new AppError(400, 'VALIDATION_ERROR', msg, details);
export const notFound = (msg = 'We could not find that.') => new AppError(404, 'NOT_FOUND', msg);
export const forbidden = (msg = 'You cannot do that.') => new AppError(403, 'FORBIDDEN', msg);
export const conflict = (code: string, msg: string) => new AppError(409, code, msg);
