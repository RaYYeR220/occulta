export function SiteHeader() {
  return (
    <header className="site-header">
      <nav className="nav-inner">
        <a className="brand" href="#top">
          <span className="mark" aria-hidden />
          Occulta
        </a>
        <div className="nav-links">
          <a href="#reveal">The Reveal</a>
          <a href="#agent">Agent</a>
          <a href="#netting">Netting</a>
          <a href="#proof">Proof</a>
        </div>
        <span className="status-pill">
          <span className="status-dot" aria-hidden />
          Sepolia — live
        </span>
      </nav>
    </header>
  );
}
