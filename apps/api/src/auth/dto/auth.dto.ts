import { z } from "zod";

export const RegisterDto = z.object({
  email: z.string().email().toLowerCase().trim(),
  password: z.string().min(8).max(200),
  name: z.string().trim().min(1).max(200).optional(),
  positions: z.array(z.string().trim().min(1).max(80)).max(10).optional(),
  bio: z.string().trim().max(500).optional(),
});
export type RegisterInput = z.infer<typeof RegisterDto>;

export const LoginDto = z.object({
  email: z.string().email().toLowerCase().trim(),
  password: z.string().min(1).max(200),
});
export type LoginInput = z.infer<typeof LoginDto>;
