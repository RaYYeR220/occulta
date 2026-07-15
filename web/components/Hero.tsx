export function Hero() {
  return (
    <section className="hero" id="top">
      <div className="eclipse" aria-hidden>
        <div className="corona" />
        <div className="disc" />
      </div>
      <div className="wrap hero-inner">
        <span className="eyebrow">Confidential strategy agents · iExec Nox</span>
        <h1>
          Occ<em>ulta</em>
        </h1>
        <p className="tagline">Hide the alpha, not just the balance.</p>
        <p className="hero-sub">
          A public strategy dies the moment it works — copied, front-run, MEV&apos;d before the
          epoch even closes. Occulta seals the strategy and every position, reveals only the
          aggregate net per epoch, and executes for real on Aave V3 and Uniswap V3.
        </p>
      </div>
    </section>
  );
}
