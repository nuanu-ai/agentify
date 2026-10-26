/**
 * The workspace's Overview, Money and Health, each a function of its view.
 * Every figure says when it was read; one whose read failed is drawn as
 * "Could not be read", never as a zero. Charts are SVG drawn here on the
 * server, with their sums written beside them and every day read out to a
 * screen reader from a list beside the picture, since a picture marked as an
 * image hides its bars from one.
 */

import { Button } from "@agentify/ui";
import { Link } from "react-router";
import { CHECK_FIELD } from "../../../src/admin/fields.js";
import type {
  Badge,
  ChartView,
  HealthRowView,
  HealthView,
  MoneyView,
  OverviewView,
  Said,
  StartRefusedView,
  TileView,
} from "../../../src/admin/figures.js";
import { StepUp } from "../../components/admin/step-up.js";
import { CouldNotBeRead } from "../../components/admin/unknown.js";
import { Moment } from "../../components/moment.js";
import { PostForm } from "../../components/post-form.js";
import { JournalList } from "./journal.js";

const BadgeOf = ({ badge }: Readonly<{ badge: Badge }>) => (
  <span className={`badge badge-${badge.tone}`}>{badge.word}</span>
);

/** Plain text, links and moments in order; a link outside the dashboard is an ordinary one. */
function SaidText({ said }: Readonly<{ said: Said }>) {
  return (
    <>
      {said.map((part, index) =>
        typeof part === "string" ? (
          // biome-ignore lint/suspicious/noArrayIndexKey: the parts of one sentence never move.
          <span key={index}>{part}</span>
        ) : "at" in part ? (
          // biome-ignore lint/suspicious/noArrayIndexKey: the parts of one sentence never move.
          <Moment key={index} at={part.at} />
        ) : part.elsewhere === true ? (
          // biome-ignore lint/suspicious/noArrayIndexKey: the parts of one sentence never move.
          <a key={index} href={part.href}>
            {part.text}
          </a>
        ) : (
          // biome-ignore lint/suspicious/noArrayIndexKey: the parts of one sentence never move.
          <Link key={index} to={part.href}>
            {part.text}
          </Link>
        ),
      )}
    </>
  );
}

/** An address shown short; it opens to its whole value, ready to select, with no script. */
function Whole({ value, short }: Readonly<{ value: string; short: string }>) {
  return (
    <span className="ident">
      {short === value ? (
        <span>{value}</span>
      ) : (
        <details className="ident-whole">
          <summary title={value}>{short}</summary>
          <span className="ident-all">{value}</span>
        </details>
      )}
    </span>
  );
}

const shortOf = (value: string) =>
  value.length <= 12 ? value : `${value.slice(0, 6)}…${value.slice(-4)}`;

function Tiles({ tiles }: Readonly<{ tiles: readonly TileView[] }>) {
  return (
    <div className="op-tiles">
      <div className="summary op-figures">
        {tiles.map((tile) => (
          <div className="tile" key={tile.label}>
            <p className="label">{tile.label}</p>
            {tile.figure === null ? (
              <p className="figure">
                <CouldNotBeRead />
              </p>
            ) : (
              <p className="figure">
                {tile.figure}
                {tile.unit === undefined && tile.of === undefined ? null : (
                  <small>{tile.unit ?? tile.of}</small>
                )}
              </p>
            )}
            <p className="aside">{tile.aside}</p>
          </div>
        ))}
      </div>
    </div>
  );
}

/** Thirty days of settled sales, with a list of every day beside it for a screen reader. */
function SalesChart({ chart, title }: Readonly<{ chart: ChartView; title: string }>) {
  return (
    <>
      <svg className="op-chart" viewBox="0 0 760 240" role="img" aria-label={chart.aria}>
        <line className="base" x1="44" y1="206" x2="752" y2="206" />
        {chart.ticks.map((tick, index) => (
          <g key={tick.label}>
            {index === 0 ? null : (
              <line className="grid" x1="44" y1={tick.y} x2="752" y2={tick.y} />
            )}
            <text className="right" x="36" y={tick.y + 4}>
              {tick.label}
            </text>
          </g>
        ))}
        {chart.bars.map((bar) => (
          <rect
            key={`${bar.x}-${bar.className}`}
            className={bar.className}
            x={bar.x}
            y={bar.y}
            width="14"
            height={bar.height}
            rx={bar.className === "bar zero" ? 1 : 3}
          >
            <title>{bar.label}</title>
          </rect>
        ))}
        {chart.days.map((day) => (
          <text key={day.label} className={day.end === true ? "mid end" : "mid"} x={day.x} y="228">
            {day.label}
          </text>
        ))}
        {chart.today === null ? null : (
          <text className="mid end" x={chart.today.x} y={chart.today.y}>
            {chart.today.label}
          </text>
        )}
      </svg>
      <ul className="sr-only" aria-label={`${title}, day by day`}>
        {chart.spoken.map((day) => (
          <li key={day}>{day}</li>
        ))}
      </ul>
    </>
  );
}

/** A part of the page whose read failed, said once with what it is. */
function Unread({ what }: Readonly<{ what: string }>) {
  return (
    <p className="op-sub op-unread">
      <CouldNotBeRead /> <span>{what}. Read the page again to try again.</span>
    </p>
  );
}

// --- the overview -----------------------------------------------------------

/** The registry of splits the gateway would refuse to start on, said where a decision waits. */
function StartRefused({ refused }: Readonly<{ refused: StartRefusedView }>) {
  return (
    <li className="op-told">
      <span className="badge badge-fail">Restart would fail</span>
      <span className="t">The gateway would refuse to start</span>
      <span className="a" />
      <div className="why">
        <p>
          It runs now. Its next start or release stops on the recorded payout splits, so no release
          goes out until they agree with this code.
        </p>
        <details className="op-why">
          <summary>The gateway's reason</summary>
          <p>{refused.why}</p>
        </details>
      </div>
      <div className="meta">
        {refused.merchant === null ? null : refused.merchant === "unread" ? (
          <span>
            Whose split it is <CouldNotBeRead />
          </span>
        ) : (
          <span>
            The split of{" "}
            <Link to={`/admin/merchants/${refused.merchant.id}`}>
              {refused.merchant.name ?? refused.merchant.id}
            </Link>
          </span>
        )}
        <Link to="/admin/money">See the splits in Money</Link>
      </div>
    </li>
  );
}

export function OverviewScreen({ view }: Readonly<{ view: OverviewView }>) {
  const { admission, startRefused } = view.needsYou;
  const waiting = admission?.kind === "read" ? admission.value : null;
  const refused = startRefused?.kind === "read" ? startRefused.value : null;
  const needs = (waiting?.of ?? 0) + (refused === null ? 0 : 1);
  const needsUnread = admission?.kind === "unread" || startRefused?.kind === "unread";
  const nothingWaits =
    needs === 0 && !needsUnread && view.worth.items.length === 0 && view.worth.unread.length === 0;
  return (
    <>
      <p className="op-asof">
        Figures read <Moment at={view.readAt} />
      </p>

      {nothingWaits ? (
        <section className="group">
          <div className="group-head">
            <h2>Nothing waits for you</h2>
          </div>
        </section>
      ) : (
        <>
          {admission === null && startRefused === null ? null : (
            <section className="group">
              <div className="group-head">
                <h2>
                  Needs you
                  {needs === 0 ? null : <span className="count warn">{needs}</span>}
                </h2>
                <p className="group-aside">Decisions only an operator can take</p>
              </div>
              {needs === 0 ? (
                needsUnread ? null : (
                  <p className="op-sub">Nobody waits for admission.</p>
                )
              ) : (
                <div className="list-box op-cols-one">
                  <ul className="list" aria-label="Decisions that need you">
                    {refused === null ? null : <StartRefused refused={refused} />}
                    {(waiting?.items ?? []).map((item) => (
                      <li className="op-told" key={item.merchantId}>
                        <span className="badge badge-notice">Waiting for admission</span>
                        <span className="t">{item.name}</span>
                        <span className="a">{item.site ?? ""}</span>
                        <p className="why">{item.why}</p>
                        <div className="meta">
                          <Link to={`/admin/merchants/${item.merchantId}`}>Review and admit</Link>
                          {item.owner === null ? null : <span>{item.owner}</span>}
                          <span>
                            Merchant since <Moment at={item.created} />
                          </span>
                        </div>
                      </li>
                    ))}
                  </ul>
                </div>
              )}
              {admission?.kind === "unread" ? <Unread what="Who waits for admission" /> : null}
              {startRefused?.kind === "unread" ? (
                <Unread what="Whether the gateway would start on the recorded splits" />
              ) : null}
              {waiting !== null && waiting.of > waiting.items.length ? (
                <p className="cut">
                  {waiting.items.length} of {waiting.of} waiting, those who waited longest first
                </p>
              ) : null}
            </section>
          )}

          <section className="group">
            <div className="group-head">
              <h2>
                Worth a look
                {view.worth.items.length === 0 ? null : (
                  <span className="count">{view.worth.items.length}</span>
                )}
              </h2>
            </div>
            {view.worth.items.length === 0 ? (
              view.worth.unread.length === 0 ? (
                <p className="op-sub">Nothing the automation has left unresolved.</p>
              ) : null
            ) : (
              <div className="list-box op-cols-one">
                <ul className="list" aria-label="Facts worth a look">
                  {view.worth.items.map((item) => (
                    <li className="op-told" key={item.title}>
                      <BadgeOf badge={item.badge} />
                      {item.href === undefined ? (
                        <span className="t">{item.title}</span>
                      ) : (
                        <Link className="t" to={item.href}>
                          {item.title}
                        </Link>
                      )}
                      <span className="a">{item.aside}</span>
                      <p className="why">{item.why}</p>
                      {item.links.length + item.meta.length === 0 ? null : (
                        <div className="meta">
                          {item.links.map((link) => (
                            <Link key={link.href} to={link.href}>
                              {link.label}
                            </Link>
                          ))}
                          {item.meta.map((meta) => (
                            <span key={meta}>{meta}</span>
                          ))}
                        </div>
                      )}
                    </li>
                  ))}
                </ul>
              </div>
            )}
            {view.worth.unread.length === 0 ? null : (
              <Unread
                what={view.worth.unread.join(", ").replace(/^./, (first) => first.toUpperCase())}
              />
            )}
          </section>
        </>
      )}

      {view.empty ? (
        <p className="op-sub op-empty">No merchant on this channel yet.</p>
      ) : (
        <>
          <Tiles tiles={view.tiles} />

          <section className="op-panel" aria-labelledby="sales-title">
            <div className="op-panel-head">
              <h2 id="sales-title">Settled sales · last 30 days</h2>
              {view.chart.kind === "read" ? <p>{view.chart.value.head}</p> : null}
            </div>
            <div className="op-panel-body">
              {view.chart.kind === "read" ? (
                <SalesChart chart={view.chart.value.chart} title="Settled sales" />
              ) : (
                <Unread what="The sales of the last 30 days" />
              )}
            </div>
            {view.chart.kind === "read" ? (
              <p className="op-panel-foot">
                USD per day, by payment date. Payments with an unknown outcome are left out, so a
                past day can still grow.
              </p>
            ) : null}
          </section>

          <section className="op-panel" aria-labelledby="funnel-title">
            <div className="op-panel-head">
              <h2 id="funnel-title">How far merchants got</h2>
              {view.funnel.kind === "read" ? <p>{view.funnel.value.lead}</p> : null}
            </div>
            <div className="op-panel-body">
              {view.funnel.kind === "read" ? (
                <ol className="op-funnel">
                  {view.funnel.value.steps.map((step) => (
                    <li key={step.label}>
                      <span className="step">{step.label}</span>
                      <span className="track" aria-hidden="true">
                        <span className="fill" style={{ width: step.share }} />
                      </span>
                      <span className="n">{step.merchants}</span>
                      <span className="rate">{step.share}</span>
                    </li>
                  ))}
                </ol>
              ) : (
                <Unread what="How far merchants got" />
              )}
            </div>
          </section>
        </>
      )}

      <JournalTail journal={view.journal} />
    </>
  );
}

function JournalTail({ journal }: Readonly<{ journal: OverviewView["journal"] }>) {
  return (
    <section className="group">
      <div className="group-head">
        <h2>Latest in the journal</h2>
        <p className="group-aside">
          <Link to="/admin/journal">The whole journal</Link>
        </p>
      </div>
      {journal.kind === "unread" ? (
        <Unread what="The journal" />
      ) : journal.value.lines.length === 0 ? (
        <p className="op-sub">No administrative action has been taken on this channel.</p>
      ) : (
        <>
          <JournalList lines={journal.value.lines} label="Latest administrative actions" />
          <p className="cut">{journal.value.cut}</p>
        </>
      )}
    </section>
  );
}

// --- money ------------------------------------------------------------------

export function MoneyScreen({ view }: Readonly<{ view: MoneyView }>) {
  return (
    <>
      <div className="list-tools op-period">
        <nav className="segments" aria-label="Period">
          {view.periods.map((period) =>
            period.here ? (
              <span key={period.label} className="here" aria-current="page">
                {period.label}
              </span>
            ) : (
              <Link key={period.label} to={period.href}>
                {period.label}
              </Link>
            ),
          )}
        </nav>
        <p className="op-asof">
          Read <Moment at={view.readAt} /> · {view.currency}
        </p>
      </div>

      <Tiles tiles={view.tiles} />

      <section className="op-panel" aria-labelledby="days-title">
        <div className="op-panel-head">
          <h2 id="days-title">Settled per day · last 30 days</h2>
          <div className="op-legend">
            <span>
              <i />
              Delivered
            </span>
            <span>
              <i className="nodel" />
              Paid, no delivery recorded
            </span>
            <span>
              <i className="zero" />
              Nothing settled
            </span>
          </div>
        </div>
        <div className="op-panel-body">
          {view.chart.kind === "read" ? (
            <SalesChart chart={view.chart.value.chart} title="Settled per day" />
          ) : (
            <Unread what="The sales of the last 30 days" />
          )}
        </div>
        {view.chart.kind === "read" ? (
          <p className="op-panel-foot">{view.chart.value.foot}</p>
        ) : null}
      </section>

      <section className="group">
        <div className="group-head">
          <h2>
            Splits
            {view.splits.kind === "read" ? (
              <span className="count">{view.splits.value.count}</span>
            ) : null}
          </h2>
          <p className="group-aside">One for every wallet a merchant set</p>
        </div>
        {view.splits.kind === "unread" ? (
          <Unread what="The splits" />
        ) : view.splits.value.count === 0 ? (
          <p className="op-sub">No payout split is recorded on this channel.</p>
        ) : (
          <>
            <div className="list-box op-cols-splits">
              <ul className="list" aria-label="Payout splits">
                <li className="list-head" aria-hidden="true">
                  <span>Merchant</span>
                  <span>Split</span>
                  <span>Pays the wallet</span>
                  <span className="num">Settled into it</span>
                  <span>Recorded</span>
                </li>
                {view.splits.value.rows.map((row) => (
                  <li className="list-row" key={row.split}>
                    <div className="cell cell-title">
                      {row.merchant === null ? (
                        <span className="soft">A merchant no longer on this channel</span>
                      ) : (
                        <Link to={`/admin/merchants/${row.merchantId}`}>{row.merchant}</Link>
                      )}
                    </div>
                    <div className="cell cell-ident">
                      <span className="said-on-narrow">Split </span>
                      <Whole value={row.split} short={shortOf(row.split)} />
                      {row.splitPage === null ? null : (
                        <>
                          {" · "}
                          <a href={row.splitPage}>explorer</a>
                        </>
                      )}
                    </div>
                    <div className="cell cell-ident">
                      <span className="said-on-narrow">Pays </span>
                      <Whole value={row.wallet} short={shortOf(row.wallet)} />
                    </div>
                    <div
                      className={row.empty ? "cell cell-amount num soft" : "cell cell-amount num"}
                    >
                      {row.settled}
                    </div>
                    <div className="cell cell-fact">
                      <span>{row.since}</span>
                      {row.earlier ? (
                        <span className="badge badge-quiet">Earlier wallet</span>
                      ) : null}
                    </div>
                  </li>
                ))}
              </ul>
            </div>
            <p className="cut">
              <span>{view.splits.value.cut}</span>
            </p>
          </>
        )}

        <section className="op-panel" aria-labelledby="payout-title">
          <div className="op-panel-head">
            <h2 id="payout-title">The operator's payout</h2>
            <p>Sent by a person, from a wallet of their own</p>
          </div>
          <div className="op-panel-body">
            {view.payout.kind === "unread" ? (
              <Unread what="The payout" />
            ) : view.payout.value.kind === "said" ? (
              <p className="op-sub">
                <BadgeOf badge={view.payout.value.badge} /> {view.payout.value.said}
              </p>
            ) : (
              <>
                <p className="op-text">{view.payout.value.intro}</p>
                {view.payout.value.parts.map((part) => (
                  <div key={part.title} className="op-payout">
                    <h3>{part.title}</h3>
                    <dl className="more-facts">
                      <div>
                        <dt>Network</dt>
                        <dd>{part.network}</dd>
                      </div>
                      <div>
                        <dt>To</dt>
                        <dd>
                          <span className="ident">
                            <span>{part.to}</span>
                          </span>{" "}
                          (Multicall3)
                        </dd>
                      </div>
                      <div>
                        <dt>Value</dt>
                        <dd>0</dd>
                      </div>
                      <div>
                        <dt>Data</dt>
                        <dd>
                          <textarea
                            className="field-input op-data"
                            readOnly
                            rows={3}
                            aria-label={`${part.title}: the transaction's data`}
                            value={part.data}
                          />
                        </dd>
                      </div>
                      <div>
                        <dt>Pays out</dt>
                        <dd>
                          <ul className="op-pays">
                            {part.pays.map((pays) => (
                              <li key={pays}>{pays}</li>
                            ))}
                            <li>{part.commission}</li>
                          </ul>
                        </dd>
                      </div>
                    </dl>
                  </div>
                ))}
              </>
            )}
          </div>
        </section>
        <p className="note">{view.note}</p>
      </section>
    </>
  );
}

// --- health -----------------------------------------------------------------

function HealthRows({
  rows,
  label,
  fact,
}: Readonly<{ rows: readonly HealthRowView[]; label: string; fact: string }>) {
  return (
    <div className="list-box op-cols-health">
      <ul className="list" aria-label={label}>
        <li className="list-head" aria-hidden="true">
          <span>Part</span>
          <span>State</span>
          <span>{fact}</span>
          <span />
        </li>
        {rows.map((row) => (
          <li className="list-row" key={row.part}>
            <div className="cell cell-title">{row.part}</div>
            <div className="cell cell-state">
              <BadgeOf badge={row.badge} />
            </div>
            <div className="cell cell-note">
              <SaidText said={row.fact} />
            </div>
            {row.check === undefined ? null : (
              <div className="cell cell-action">
                <PostForm action="/admin/health" document>
                  {(pending) => (
                    <>
                      <input type="hidden" name={CHECK_FIELD} value={row.check} />
                      <Button variant="secondary" compact pending={pending}>
                        Check now
                      </Button>
                    </>
                  )}
                </PostForm>
              </div>
            )}
          </li>
        ))}
      </ul>
    </div>
  );
}

export function HealthScreen({ view }: Readonly<{ view: HealthView }>) {
  return (
    <>
      <div className="op-asof-row">
        <p className="op-asof">
          Read <Moment at={view.readAt} />
        </p>
        <a className="button button-secondary button-compact" href={view.grafana}>
          Requests and hosts in Grafana
        </a>
      </div>
      {view.stepUp === null ? null : (
        <div className="op-decide">
          <StepUp view={view.stepUp} pressed />
        </div>
      )}

      <section className="group">
        <div className="group-head">
          <h2>What the application reads</h2>
        </div>
        <HealthRows
          rows={view.read}
          label="Parts the application reads"
          fact="What stands behind it"
        />
      </section>

      <section className="group">
        <div className="group-head">
          <h2>What the application cannot see</h2>
        </div>
        <HealthRows
          rows={view.unseen}
          label="Parts the application does not measure"
          fact="Where the fact lives"
        />
      </section>
    </>
  );
}
