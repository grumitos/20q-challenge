import type { ReactNode } from "react";
import Link from "next/link";

export function LegalShell({
  eyebrow,
  title,
  summary,
  children,
}: {
  eyebrow: string;
  title: string;
  summary: string;
  children: ReactNode;
}) {
  return (
    <main className="legal-shell">
      <header className="legal-site-header">
        <Link className="brand legal-brand" href="/" aria-label="Volver a 20Q Challenge">
          {/* eslint-disable-next-line @next/next/no-img-element */}
          <img className="brand-logo" src="/brand-logo.webp" alt="" width={32} height={32} />
          <strong>20Q Challenge</strong>
        </Link>
        <nav className="legal-nav" aria-label="Documentos legales">
          <Link href="/privacy">Privacidad</Link>
          <Link href="/terms">Términos</Link>
        </nav>
      </header>

      <article className="legal-document">
        <header className="legal-intro">
          <span>{eyebrow}</span>
          <h1>{title}</h1>
          <p>{summary}</p>
        </header>
        <div className="legal-content">{children}</div>
      </article>

      <footer className="legal-footer">
        <span>Vigente desde el 15 de julio de 2026</span>
        <Link href="/">Volver al ranking</Link>
      </footer>
    </main>
  );
}

export function LegalSection({ title, children }: { title: string; children: ReactNode }) {
  return (
    <section>
      <h2>{title}</h2>
      {children}
    </section>
  );
}
