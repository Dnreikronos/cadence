export function Placeholder({ title, children }: { title: string; children?: React.ReactNode }) {
  return (
    <main className="mx-auto flex min-h-svh max-w-xl flex-col justify-center gap-3 p-6">
      <h1 className="text-2xl font-semibold">{title}</h1>
      <div className="text-muted-foreground">{children}</div>
    </main>
  );
}
