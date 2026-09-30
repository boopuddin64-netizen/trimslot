import { z } from 'zod';
import { badRequest } from './errors';

export function parse<T extends z.ZodTypeAny>(schema: T, data: unknown): z.infer<T> {
  const r = schema.safeParse(data);
  if (!r.success) {
    const issue = r.error.issues[0];
    const field = issue.path.join('.');
    throw badRequest(field ? `${field}: ${issue.message}` : issue.message, r.error.issues.map((i) => ({ field: i.path.join('.'), message: i.message })));
  }
  return r.data;
}

export const normPhone = (p: string) => {
  let s = p.replace(/[\s\-()]/g, '');
  if (s.startsWith('+234')) s = '0' + s.slice(4);
  else if (s.startsWith('234') && s.length === 13) s = '0' + s.slice(3);
  return s;
};

export const phoneSchema = z.string().trim().transform(normPhone).refine((s) => /^0[789][01]\d{8}$/.test(s) || /^\+?\d{8,15}$/.test(s), 'Enter a valid phone number (e.g. 0803 123 4567)');
export const emailSchema = z.string().trim().toLowerCase().email('Enter a valid email address');
const hhmm = z.string().regex(/^([01]\d|2[0-3]):[0-5]\d$/, 'Use HH:MM (24h)');

export const signupSchema = z.object({
  role: z.enum(['customer', 'barber']),
  name: z.string().trim().min(2, 'Name is too short').max(80),
  email: emailSchema.optional().or(z.literal('').transform(() => undefined)),
  phone: phoneSchema.optional().or(z.literal('').transform(() => undefined)),
  password: z.string().min(8, 'Password must be at least 8 characters').max(100),
  shop_name: z.string().trim().min(2).max(80).optional(),
  location: z.string().trim().max(160).optional(),
}).refine((d) => d.email || d.phone, { message: 'Provide an email or a phone number', path: ['email'] })
  .refine((d) => d.role !== 'barber' || !!d.shop_name, { message: 'Shop name is required for barbers', path: ['shop_name'] });

export const loginSchema = z.object({ identifier: z.string().trim().min(3, 'Enter your email or phone'), password: z.string().min(1, 'Enter your password') });

export const createBookingSchema = z.object({
  barber_id: z.coerce.number().int().positive(),
  service_id: z.coerce.number().int().positive(),
  date: z.string(),
  time: z.string(),
  payment_option: z.enum(['ONLINE', 'ON_ARRIVAL', 'PLAN', 'CREDIT']),
  plan_purchase_id: z.coerce.number().int().positive().optional(),
  credit_id: z.coerce.number().int().positive().optional(),
}); // NOTE: zod strips unknown keys, so a client-sent "price" is ignored.

export const meSchema = z.object({
  name: z.string().trim().min(2, 'Name is too short').max(80).optional(),
  email: emailSchema.or(z.literal('')).optional(),
  phone: phoneSchema.or(z.literal('')).optional(),
}).strict();

export const profileSchema = z.object({
  name: z.string().trim().min(2).max(80).optional(),
  shop_name: z.string().trim().min(2).max(80).optional(),
  photo_url: z.string().trim().max(500).refine((s) => s === '' || /^https?:\/\//i.test(s) || /^\/api\/barbers\/\d+\/photo(\?v=[a-z0-9]+)?$/.test(s), 'Photo must be an http(s) URL').optional(),
  location: z.string().trim().max(160).optional(),
  about: z.string().trim().max(600).optional(),
  paystack_subaccount: z.string().trim().max(60).regex(/^(ACCT_[A-Za-z0-9]+)?$/, 'Subaccount code looks like ACCT_xxxxxxxx').optional(),
});

export const scheduleSchema = z.object({
  days: z.array(z.object({
    weekday: z.number().int().min(0).max(6),
    is_working: z.boolean(),
    start: hhmm, end: hhmm,
    break_start: hhmm.nullable().optional(), break_end: hhmm.nullable().optional(),
  })).length(7, 'Provide all 7 days'),
  confirm: z.boolean().optional(),
});
export type ScheduleInput = z.infer<typeof scheduleSchema>;

export const serviceSchema = z.object({
  name: z.string().trim().min(2, 'Name is too short').max(60),
  price_naira: z.coerce.number().min(0, 'Price cannot be negative').max(10_000_000),
  duration_min: z.coerce.number().int().min(5, 'Minimum 5 minutes').max(480),
});

export const dayOffSchema = z.object({ date: z.string(), reason: z.string().trim().max(120).optional(), confirm: z.boolean().optional() });
