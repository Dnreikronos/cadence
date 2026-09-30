export function PageHeader({
  eyebrow,
  title,
  description,
}: {
  eyebrow: string
  title: string
  description?: string
}) {
  return (
    <div>
      <p className="text-label text-ink-muted">{eyebrow}</p>
      <h1 className="mt-1 text-title text-ink">{title}</h1>
      {description && (
        <p className="mt-1 text-ui text-ink-muted">{description}</p>
      )}
    </div>
  )
}
