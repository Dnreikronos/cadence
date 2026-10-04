import { z } from "zod"

export const auditorSchema = z.object({
  email: z
    .string()
    .trim()
    .max(320, "That email is too long")
    .regex(/^[^@\s]+@[^@\s]+$/, "Enter a valid email address"),
})
