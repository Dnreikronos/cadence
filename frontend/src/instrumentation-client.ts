// Runs in the browser before the app's own modules and before hydration (Next 15.3+).
// The one place client-wide settings that must precede the first schema go.
import "@/lib/zod-config"
