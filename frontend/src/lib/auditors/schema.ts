import { z } from "zod"

// The same rule as the service and the invites table, so the form never sends
// what the API would answer with invalid_request.
export const auditorSchema = z.object({
  email: z
    .string()
    .trim()
    .min(1, "Enter an email address")
    .max(320, "That email is too long")
    .regex(/^[^@\s]+@[^@\s]+$/, "Enter a valid email address"),
})
