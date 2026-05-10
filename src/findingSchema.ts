import { z } from "zod";

export const findingSchema = z.object({
  file: z.string(),
  line: z.number().int().min(1),
  endLine: z.number().int().min(1).optional(),
  agent: z.enum(["clean-coder", "tester", "architect", "ddd-reviewer", "performance"]),
  severity: z.enum(["critical", "warning", "info"]),
  category: z.string(),
  message: z.string(),
  suggestion: z.string(),
  fingerprint: z.string().optional(),
});

export type Finding = z.infer<typeof findingSchema>;
