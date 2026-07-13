import { z } from "zod";

/**
 * The Trace is the atom of CAPTURE. One proxied model call in, one Trace out.
 * Pure domain schema — no framework, no network. Persistence (Supabase) and
 * transport (the proxy route) live outside core and depend on these types.
 */

export const RoleSchema = z.enum(["system", "user", "assistant", "tool"]);
export type Role = z.infer<typeof RoleSchema>;

export const MessageSchema = z.object({
  role: RoleSchema,
  content: z.string(),
});
export type Message = z.infer<typeof MessageSchema>;

export const TraceSchema = z.object({
  id: z.string().uuid(),
  org_id: z.string().uuid(),
  task_id: z.string().uuid().nullable(),
  model: z.string().min(1),
  prompt_messages: z.array(MessageSchema),
  output: z.string().nullable(),
  latency_ms: z.number().int().nonnegative().nullable(),
  tokens_in: z.number().int().nonnegative().nullable(),
  tokens_out: z.number().int().nonnegative().nullable(),
  cost_estimate: z.number().nonnegative().nullable(),
  created_at: z.string(),
});
export type Trace = z.infer<typeof TraceSchema>;

/** Shape the proxy assembles before an id/created_at is assigned by the DB. */
export const NewTraceSchema = TraceSchema.omit({ id: true, created_at: true });
export type NewTrace = z.infer<typeof NewTraceSchema>;

/**
 * A Correction is the gold: a human's edit of a Trace's output. First-class,
 * because this is the knowledge that would otherwise leak to the vendor.
 */
export const CorrectionSchema = z.object({
  trace_id: z.string().uuid(),
  org_id: z.string().uuid(),
  corrected_output: z.string().min(1),
  rating: z.number().int().min(1).max(5),
  reason: z.string().nullable(),
  author: z.string().uuid().nullable(),
  created_at: z.string(),
});
export type Correction = z.infer<typeof CorrectionSchema>;

export const NewCorrectionSchema = CorrectionSchema.omit({
  org_id: true,
  created_at: true,
}).extend({
  reason: z.string().nullable().default(null),
});
export type NewCorrection = z.infer<typeof NewCorrectionSchema>;
