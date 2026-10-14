import "./sell-landing.css";

import { BrandMark } from "@agentify/ui";
import { Fragment, useEffect, useRef, useState } from "react";
import type { SellLanding } from "../content/sell";
import { SiteLink } from "./site-link";

const SIGN_IN = "/dashboard/sign-in";

/**
 * The merchant landing, drawn from its words with its own stylesheet; the
 * doors to the dashboard and the documentation are other processes, so they
 * are plain anchors, and the way home is the scanner's own link.
 */
export function SellLandingPage({ content }: Readonly<{ content: SellLanding }>) {
  const { hero, sale, journey, card, connect, money, pricing, dashboard, questions, closing } =
    content;
  const { links } = content;
  return (
    <div className="sell">
      <Masthead content={content} />
      <main>
        <section className="hero">
          <div>
            <p className="eyebrow">{hero.eyebrow}</p>
            <h1 className="hero__title">{hero.title}</h1>
            <p className="hero__lede">{hero.lede}</p>
            <div className="hero__actions">
              <a className="button button-primary" href={SIGN_IN}>
                {hero.action}
              </a>
              <a className="button button-secondary" href="#how">
                {hero.howItWorks}
              </a>
            </div>
            <ul className="hero__facts">
              {hero.facts.map((fact, index) => (
                <li key={fact}>
                  <span>{step(index)}</span>
                  {fact}
                </li>
              ))}
            </ul>
          </div>
          <div aria-label={sale.label} className="commerce-demo">
            <div className="commerce-demo__top">
              <span>{sale.top}</span>
              <span className="commerce-demo__status">
                <i />
                {sale.status}
              </span>
            </div>
            <div className="commerce-demo__scene">
              <div className="scene-card scene-card--agent">
                <div aria-hidden="true" className="agent-face">
                  <span />
                  <span />
                </div>
                <div className="scene-agent__copy">
                  <small>{sale.agent.kind}</small>
                  <b>{sale.agent.wants}</b>
                  <span className="agent-check">{sale.agent.done}</span>
                </div>
              </div>
              <div className="scene-bridge">
                <b>Agentify</b>
                <span className="scene-bridge__arrow">→</span>
              </div>
              <div className="scene-card scene-card--store">
                <div className="scene-card__head">
                  <span className="scene-icon">
                    <Icon paths={["M3 10h18M5 10v9h14v-9M4 4h16l1 6H3l1-6Zm5 15v-5h6v5"]} />
                  </span>
                  <div>
                    <small>{sale.store.kind}</small>
                    <b>{sale.store.name}</b>
                  </div>
                </div>
                <div className="scene-product">
                  <span className="scene-product__thumb">✦</span>
                  <div className="scene-product__copy">
                    <div>
                      <b>{sale.product.name}</b>
                      <strong>{sale.product.price}</strong>
                    </div>
                  </div>
                </div>
              </div>
              <div className="payment-result">
                <span className="scene-icon scene-icon--wallet">
                  <Icon
                    paths={[
                      "M4 7h15a2 2 0 0 1 2 2v9H4a2 2 0 0 1-2-2V6a2 2 0 0 1 2-2h13v3m0 5h4m-4 0h.01",
                    ]}
                  />
                </span>
                <div>
                  <small>{sale.paid.kind}</small>
                  <strong>{sale.paid.amount}</strong>
                  <span className="payment-result__note">{sale.paid.note}</span>
                </div>
                <span className="payment-result__check">✓</span>
              </div>
            </div>
            <div className="commerce-demo__foot">
              {sale.path.map((part) => (
                <Fragment key={part}>
                  <span>{part}</span>
                  <i>→</i>
                </Fragment>
              ))}
              <b>{sale.end}</b>
            </div>
          </div>
        </section>

        <section className="section" id="how">
          <div className="section-head">
            <p className="eyebrow">{journey.eyebrow}</p>
            <h2>{journey.title}</h2>
            <p>{journey.lede}</p>
          </div>
          <div className="journey-grid">
            {journey.steps.map((item, index) => (
              <article key={item.title}>
                <span className="step">{step(index)}</span>
                <div className="journey-icon">{JOURNEY_ICONS[index]}</div>
                <h3>{item.title}</h3>
                <p>{item.text}</p>
              </article>
            ))}
          </div>
        </section>

        <section className="section code-section">
          <div className="code-copy">
            <p className="eyebrow">{card.eyebrow}</p>
            <h2>{card.title}</h2>
            <p>{card.lede}</p>
            <ul className="card-fields">
              {card.fields.map(([name, text]) => (
                <li key={name}>
                  <b>{name}</b>
                  <span>{text}</span>
                </li>
              ))}
            </ul>
            <p>{card.after}</p>
            <a className="text-link" href="/docs/cards">
              {card.link}
            </a>
          </div>
          <div className="panel">
            <div className="panel__label mono">{card.codeLabel}</div>
            <pre>
              <code>
                {card.code.map((part, index) =>
                  typeof part === "string" ? (
                    part
                  ) : (
                    // biome-ignore lint/suspicious/noArrayIndexKey: the example is fixed, so a token's place is its identity
                    <span className={`tok-${part[1]}`} key={index}>
                      {part[0]}
                    </span>
                  ),
                )}
              </code>
            </pre>
          </div>
        </section>

        <section className="section" id="connect">
          <div className="section-head">
            <p className="eyebrow">{connect.eyebrow}</p>
            <h2>{connect.title}</h2>
          </div>
          <div className="connect-grid">
            {[
              { way: connect.woo, accent: true, href: SIGN_IN },
              { way: connect.sdk, accent: false, href: "/docs/quickstart" },
            ].map(({ way, accent, href }) => (
              <article
                className={accent ? "connect-card connect-card--accent" : "connect-card"}
                key={way.title}
              >
                <div>
                  <span className="connect-tag">{way.tag}</span>
                  <h3>{way.title}</h3>
                  <p>{way.text}</p>
                </div>
                <ul>
                  {way.points.map((point) => (
                    <li key={point}>{point}</li>
                  ))}
                </ul>
                <a
                  className={`button ${accent ? "button-primary" : "button-secondary"}`}
                  href={href}
                >
                  {way.action}
                </a>
              </article>
            ))}
          </div>
        </section>

        <section className="section money" id="money">
          <div className="money__copy">
            <p className="eyebrow">{money.eyebrow}</p>
            <h2>{money.title}</h2>
            <p>{money.lede}</p>
            <div className="money__notes">
              {money.notes.map((note) => (
                <span key={note}>{note}</span>
              ))}
            </div>
          </div>
          <div aria-label={money.map.label} className="payment-map">
            <div className="payment-map__top">
              <span>{money.map.top}</span>
              <span className="commerce-demo__status">
                <i />
                {money.map.status}
              </span>
            </div>
            <div className="payment-map__body">
              <Wallet side={money.map.buyer} />
              <div className="payment-flow">
                <span>{money.map.flow.amount}</span>
                <i />
                <small>{money.map.flow.note}</small>
              </div>
              <Wallet merchant side={money.map.seller} />
            </div>
            <div className="payment-map__foot">{money.map.foot}</div>
          </div>
        </section>

        {pricing.options.length > 0 ? (
          <div className="pricing" id="pricing">
            {pricing.options.map((tariff) => (
              <section
                aria-labelledby={`pricing-${tariff.id}-title`}
                className="section"
                id={`pricing-${tariff.id}`}
                key={tariff.id}
              >
                {pricing.notesShown ? <p className="tariff-flag">{tariff.note}</p> : null}
                <div className="section-head">
                  <p className="eyebrow">{pricing.eyebrow}</p>
                  <h2 id={`pricing-${tariff.id}-title`}>{pricing.title}</h2>
                </div>
                <div className="tariff__answer">
                  <div className="tariff__offer">
                    <h3>{tariff.name}</h3>
                    <p className="tariff__price">{tariff.price}</p>
                    {"per" in tariff ? <p className="tariff__per">{tariff.per}</p> : null}
                    <p className="tariff__gist">{tariff.gist}</p>
                    <ul className="tariff__terms">
                      {tariff.terms.map((term) => (
                        <li key={term}>{term}</li>
                      ))}
                    </ul>
                    <a className="button button-primary" href={SIGN_IN}>
                      {pricing.action}
                    </a>
                  </div>
                  <div className="tariff__includes">
                    <p className="tariff__list-title">{pricing.includesTitle}</p>
                    <ul>
                      {tariff.includes.map((item) => (
                        <li key={item}>{item}</li>
                      ))}
                    </ul>
                  </div>
                </div>
              </section>
            ))}
          </div>
        ) : null}

        <section aria-labelledby="dashboard" className="section dashboard-preview">
          <div className="dashboard-preview__copy">
            <p className="eyebrow">{dashboard.eyebrow}</p>
            <h2 id="dashboard">{dashboard.title}</h2>
            <p>{dashboard.lede}</p>
            <ul className="dashboard-list">
              {dashboard.parts.map(([name, text]) => (
                <li key={name}>
                  <b>{name}</b>
                  <span>{text}</span>
                </li>
              ))}
            </ul>
            <a className="button button-secondary" href={SIGN_IN}>
              {dashboard.action}
            </a>
          </div>
          <DashboardWindow view={dashboard.window} />
        </section>

        <section className="section faq">
          <div className="section-head">
            <p className="eyebrow">{questions.eyebrow}</p>
            <h2>{questions.title}</h2>
          </div>
          <div className="faq-grid">
            {questions.answers.map(([question, answer], index) => (
              <details key={question} open={index === 0}>
                <summary>{question}</summary>
                <p>{answer}</p>
              </details>
            ))}
          </div>
        </section>

        <section className="final-cta">
          <div>
            <p className="eyebrow">{closing.eyebrow}</p>
            <h2>{closing.title}</h2>
            <p>{closing.text}</p>
          </div>
          <div>
            <a className="button button-primary" href={SIGN_IN}>
              {links.signUp}
            </a>
            <a className="button button-secondary" href="/docs/">
              {links.documentation}
            </a>
          </div>
        </section>
      </main>
      <footer className="colophon">
        <Wordmark size="footer" />
        <p>{content.footer.line}</p>
        <div className="colophon__links">
          <a href="/docs/">{links.documentation}</a>
          <a href={SIGN_IN}>{links.signIn}</a>
          <a href={SIGN_IN}>{links.signUp}</a>
        </div>
        <span className="mono">{content.footer.copyright}</span>
      </footer>
    </div>
  );
}

/**
 * The header: the page's sections and the doors to the documentation and the
 * dashboard. Below the desktop width the sections fold into a menu the burger
 * opens; a chosen link, Escape, or growing back to the desktop width closes it.
 */
function Masthead({ content }: Readonly<{ content: SellLanding }>) {
  const { links } = content;
  const [open, setOpen] = useState(false);
  const burger = useRef<HTMLButtonElement>(null);

  useEffect(() => {
    if (!open) return;
    const desktop = matchMedia("(min-width: 1001px)");
    const closeOnEscape = (event: KeyboardEvent) => {
      if (event.key !== "Escape") return;
      setOpen(false);
      burger.current?.focus();
    };
    const closeOnDesktop = (event: MediaQueryListEvent) => {
      if (event.matches) setOpen(false);
    };
    document.addEventListener("keydown", closeOnEscape);
    desktop.addEventListener("change", closeOnDesktop);
    return () => {
      document.removeEventListener("keydown", closeOnEscape);
      desktop.removeEventListener("change", closeOnDesktop);
    };
  }, [open]);

  const close = () => setOpen(false);
  const sections: readonly (readonly [string, string])[] = [
    ["#how", links.howItWorks],
    ["#connect", links.integrations],
    ["#money", links.payments],
    ...(content.pricing.options.length > 0 ? [["#pricing", links.pricing] as const] : []),
  ];
  return (
    <header className="masthead">
      <Wordmark size="header" />
      <nav aria-label="Sections" className="masthead__links">
        {sections.map(([href, label]) => (
          <a href={href} key={href}>
            {label}
          </a>
        ))}
      </nav>
      <nav aria-label="Account and help" className="masthead__nav">
        <a href="/docs/">{links.documentation}</a>
        <a href={SIGN_IN}>{links.signIn}</a>
        <a className="button button-compact button-primary" href={SIGN_IN}>
          {links.signUp}
        </a>
      </nav>
      <button
        aria-controls="site-menu"
        aria-expanded={open}
        aria-label={open ? "Close menu" : "Open menu"}
        className="masthead__burger"
        onClick={() => setOpen(!open)}
        ref={burger}
        type="button"
      >
        <span />
        <span />
        <span />
      </button>
      <nav aria-label="Menu" className="site-menu" hidden={!open} id="site-menu">
        {sections.map(([href, label]) => (
          <a href={href} key={href} onClick={close}>
            {label}
          </a>
        ))}
        <a href="/docs/" onClick={close}>
          {links.documentation}
        </a>
        <a href={SIGN_IN} onClick={close}>
          {links.signIn}
        </a>
        <a className="button button-primary" href={SIGN_IN} onClick={close}>
          {links.signUp}
        </a>
      </nav>
    </header>
  );
}

function Wordmark({ size }: Readonly<{ size: "header" | "footer" }>) {
  return (
    <SiteLink
      aria-label={size === "header" ? "Agentify home" : undefined}
      className={size === "header" ? "wordmark" : "wordmark wordmark--footer"}
      to="/"
    >
      <span className="wordmark__mark">
        <BrandMark />
      </span>
      <span className="wordmark__name">Agentify</span>
    </SiteLink>
  );
}

function Wallet({
  side,
  merchant = false,
}: Readonly<{
  side: Readonly<{ kind: string; name: string; amount: string }>;
  merchant?: boolean;
}>) {
  return (
    <div className={merchant ? "wallet wallet--merchant" : "wallet"}>
      <div className="wallet__head">
        <span className="wallet__icon">
          <Icon paths={WALLET_PATHS} />
        </span>
        <div>
          <small>{side.kind}</small>
          <b>{side.name}</b>
        </div>
      </div>
      {merchant ? (
        <strong className="wallet__amount">{side.amount}</strong>
      ) : (
        <span className="wallet__amount">{side.amount}</span>
      )}
    </div>
  );
}

function DashboardWindow({ view: shown }: Readonly<{ view: SellLanding["dashboard"]["window"] }>) {
  return (
    <div className="mini-app">
      <aside className="mini-app__side">
        <div className="mini-app__brand">
          <b>{shown.brand}</b>
          <small>{shown.kind}</small>
        </div>
        <ol className="mini-app__nav">
          {shown.sections.map((section, index) => (
            <li className={index === 0 ? "active" : undefined} key={section}>
              <i>{index + 1}</i>
              {section}
            </li>
          ))}
        </ol>
        <p className="mini-app__help">
          {shown.help[0]}
          <b>{shown.help[1]}</b>
        </p>
        <p className="mini-app__who">
          <i>{shown.account.initial}</i>
          <span>
            <b>{shown.account.name}</b>
            {shown.account.email}
          </span>
        </p>
      </aside>
      <div className="mini-app__main">
        <div className="mini-app__top">
          <b>{shown.heading}</b>
          <span className="mini-app__state">{shown.state}</span>
        </div>
        <div className="mini-app__body">
          <div className="mini-app__bar">
            {shown.counts.map(([label, count]) => (
              <span className="mini-app__count" key={label}>
                {label} <b>{count}</b>
              </span>
            ))}
            <span className="mini-app__stop">{shown.stop}</span>
          </div>
          <table className="mini-app__table">
            <thead>
              <tr>
                <th>{shown.columns[0]}</th>
                <th>{shown.columns[1]}</th>
                <th className="mini-app__when">{shown.columns[2]}</th>
                <th>{shown.columns[3]}</th>
              </tr>
            </thead>
            <tbody>
              {shown.rows.map(([name, id, price, when, state]) => (
                <tr key={id}>
                  <td>
                    <b>{name}</b>
                    <small>{id}</small>
                  </td>
                  <td>{price}</td>
                  <td className="mini-app__when">{when}</td>
                  <td>
                    <span className={state === "sales paused" ? "mini-app__off" : "mini-app__on"}>
                      {state}
                    </span>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
          <p className="mini-app__note">{shown.note}</p>
        </div>
      </div>
    </div>
  );
}

const step = (index: number): string => String(index + 1).padStart(2, "0");

const WALLET_PATHS = [
  "M4 7h15a2 2 0 0 1 2 2v9H4a2 2 0 0 1-2-2V6a2 2 0 0 1 2-2h13v3",
  "M16 12h5M16 12h.01",
];

function Icon({ paths }: Readonly<{ paths: readonly string[] }>) {
  return (
    <svg aria-hidden="true" viewBox="0 0 24 24">
      {paths.map((d) => (
        <path d={d} key={d} />
      ))}
    </svg>
  );
}

const JOURNEY_ICONS = [
  <svg aria-hidden="true" key="box" viewBox="0 0 24 24">
    <path d="m21 8-9-5-9 5 9 5 9-5Z" />
    <path d="m3 8 9 5 9-5M12 13v8M5 10v7l7 4 7-4v-7" />
  </svg>,
  <svg aria-hidden="true" key="send" viewBox="0 0 24 24">
    <path d="m22 2-7 20-4-9-9-4Z" />
    <path d="M22 2 11 13" />
  </svg>,
  <svg aria-hidden="true" key="cart" viewBox="0 0 24 24">
    <circle cx="9" cy="20" r="1" />
    <circle cx="19" cy="20" r="1" />
    <path d="M3 4h2l2.4 10.2a2 2 0 0 0 2 1.6h7.8a2 2 0 0 0 2-1.6L21 8H6" />
  </svg>,
  <svg aria-hidden="true" key="wallet" viewBox="0 0 24 24">
    <path d="M4 7h15a2 2 0 0 1 2 2v9H4a2 2 0 0 1-2-2V6a2 2 0 0 1 2-2h13v3" />
    <path d="M16 12h5M16 12h.01" />
  </svg>,
];
