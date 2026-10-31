import { useEffect, useRef, useState, type FormEvent, type ReactNode } from "react";
import { AnimatePresence, motion, useReducedMotion } from "motion/react";
import { ArrowDown, ArrowRight, ArrowUpRight } from "lucide-react";
import SiriOrb from "@/components/smoothui/siri-orb";
import { HeroDisplay } from "./HeroDisplay";
import { SceneRing } from "./SceneRing";
import { HowItWorks } from "./HowItWorks";
import { AmbienceDemo, ChatDemo, HandsOnDemo, TimeDemo, TrustDemo } from "./FeatureDemos";
import { EASE, InkText, Reveal, Wordmark } from "./shared";

/**
 * Where "进入 VIVIC" and a successful signup go. The dev server serves the
 * user page at /; a standalone or hosted build has no app beside it, so it
 * is built with VITE_LANDING_APP_URL pointing at the local Vivic.
 */
const APP_URL: string = import.meta.env.VITE_LANDING_APP_URL || "/";
const APP_IS_LOCAL = APP_URL !== "/";

const NAV = [
  { href: "#scenes", label: "卡片" },
  { href: "#how", label: "工作方式" },
  { href: "#trust", label: "可信" },
  { href: "#ambience", label: "氛围" },
];

/** Puts the cursor in the beta form at the top of the page. */
const focusBeta = (event?: React.MouseEvent) => {
  event?.preventDefault();
  const email = document.getElementById("betaEmail") as HTMLInputElement | null;
  document.getElementById("beta")?.scrollIntoView({ behavior: "smooth", block: "center" });
  setTimeout(() => email?.focus({ preventScroll: true }), 450);
};

/**
 * Demo signup: any well-formed email counts as a beta user. Nothing is sent
 * or stored; the page confirms and opens the user page at /.
 */
function BetaForm() {
  const [state, setState] = useState<"idle" | "success">("idle");
  const formRef = useRef<HTMLFormElement>(null);
  useEffect(() => {
    // Coming back from the user page (bfcache) shows a fresh form again.
    const reset = (event: PageTransitionEvent) => { if (event.persisted) setState("idle"); };
    window.addEventListener("pageshow", reset);
    return () => window.removeEventListener("pageshow", reset);
  }, []);
  const submit = (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    if (state === "success" || !event.currentTarget.reportValidity()) return;
    setState("success");
    setTimeout(() => window.location.assign(APP_URL), 700);
  };
  const success = state === "success";
  return <form ref={formRef} id="beta" className="lp-beta" onSubmit={submit} aria-busy={success || undefined} noValidate={false}>
    <label className="sr-only" htmlFor="betaEmail">接收内测邀请的邮箱</label>
    <input id="betaEmail" className="lp-input" type="email" name="email" required autoComplete="email" placeholder="输入邮箱，申请内测"
      readOnly={success} onInput={() => { if (!success) setState("idle"); }} />
    <button id="betaSubmit" className="lp-button lp-button-dark" type="submit" disabled={success}>
      {success ? "申请成功" : <>申请内测<ArrowRight size={16} aria-hidden /></>}
    </button>
    <p id="betaStatus" className="lp-beta-status" data-state={success ? "success" : undefined} role="status">
      {success ? "申请成功，你已成为 VIVIC 内测用户，正在进入…" : ""}
    </p>
  </form>;
}

function Header() {
  const [shown, setShown] = useState(false);
  useEffect(() => {
    const update = () => setShown(window.scrollY > window.innerHeight * 0.72);
    update();
    window.addEventListener("scroll", update, { passive: true });
    return () => window.removeEventListener("scroll", update);
  }, []);
  return <AnimatePresence>
    {shown && <motion.header className="lp-header" initial={{ opacity: 0, y: -12 }} animate={{ opacity: 1, y: 0 }} exit={{ opacity: 0, y: -12 }} transition={{ duration: 0.35, ease: EASE }}>
      <a href="#top" className="lp-header-brand" aria-label="回到顶部"><Wordmark /></a>
      <nav className="lp-header-nav" aria-label="页面导航">{NAV.map(item => <a key={item.href} href={item.href}>{item.label}</a>)}</nav>
      <div className="lp-header-actions">
        <a className="lp-header-link" href={APP_URL}>进入 VIVIC</a>
        <a className="lp-button lp-button-pill" href="#beta" onClick={focusBeta}>申请内测</a>
      </div>
    </motion.header>}
  </AnimatePresence>;
}

function Hero() {
  const reduced = useReducedMotion();
  const item = (delay: number) => ({ initial: reduced ? false : { opacity: 0, y: 18 }, animate: { opacity: 1, y: 0 }, transition: { duration: 0.9, ease: EASE, delay } });
  return <section className="lp-hero" id="top">
    <HeroDisplay />
    <div className="lp-hero-side">
      <motion.p className="lp-kicker" {...item(0.05)}><span className="lp-dot" />个人信息画布 · 首批内测招募中</motion.p>
      <motion.h1 className="lp-hero-title" {...item(0.12)}>
        <Wordmark beta className="lp-hero-wordmark" />
        <span className="lp-hero-tagline"><span>说出你的想法，</span><span>让信息在眼前归位。</span></span>
      </motion.h1>
      <motion.p className="lp-hero-lede" {...item(0.22)}>
        倒计时、待办、日程、方案对比、照片回忆……<br />说一句话，Vivic 就把它整理成合适的卡片，安静地留在你的屏幕上。
      </motion.p>
      <motion.div className="lp-hero-form" {...item(0.32)}>
        <BetaForm />
        <div className="lp-or"><span>已经是内测用户</span></div>
        <a className="lp-button lp-button-light" href={APP_URL}>进入 VIVIC<ArrowUpRight size={16} aria-hidden /></a>
      </motion.div>
      <motion.a className="lp-more" href="#scenes" {...item(0.45)}>了解更多<ArrowDown size={14} aria-hidden /></motion.a>
      <p className="lp-legal">提交即表示同意我们仅用此邮箱发送内测邀请与相关通知。</p>
    </div>
  </section>;
}

function SectionHead({ eyebrow, title, children, align = "center" }: { eyebrow: string; title: ReactNode; children?: ReactNode; align?: "center" | "left" }) {
  return <div className={`lp-section-head${align === "left" ? " is-left" : ""}`}>
    <Reveal className="lp-eyebrow">{eyebrow}</Reveal>
    <Reveal as="h2" className="lp-h2" delay={0.06}>{title}</Reveal>
    {children && <Reveal as="p" className="lp-lede" delay={0.12}>{children}</Reveal>}
  </div>;
}

function Feature({ id, eyebrow, title, children, demo, reverse = false }: {
  id: string; eyebrow: string; title: ReactNode; children: ReactNode; demo: ReactNode; reverse?: boolean;
}) {
  return <section className={`lp-feature${reverse ? " is-reverse" : ""}`} id={id}>
    <div className="lp-feature-text">
      <Reveal className="lp-eyebrow">{eyebrow}</Reveal>
      <Reveal as="h2" className="lp-h3" delay={0.06}>{title}</Reveal>
      <Reveal className="lp-feature-body" delay={0.12}>{children}</Reveal>
    </div>
    <Reveal className="lp-feature-demo" y={40}>{demo}</Reveal>
  </section>;
}

export function LandingPage() {
  return <div className="lp">
    <Header />
    <main>
      <Hero />

      <section className="lp-scenes" id="scenes">
        <SectionHead eyebrow="SAY IT · SEE IT" title={<>你只管说，<br />形式交给 Vivic。</>}>
          二十多种卡片，按你说的话自动选择：倒计时留数字，对比列成表，照片讲成故事。拖动看看。
        </SectionHead>
        <Reveal y={40}><SceneRing /></Reveal>
        <p className="lp-footnote">页面中的卡片均为示例数据，由产品里同一套卡片组件绘制。</p>
      </section>

      <section className="lp-how-section" id="how">
        <SectionHead eyebrow="TWO WINDOWS · ONE CANVAS" title={<>一边说，<br />一边看。</>}>
          用户页只负责输入和操作；展示窗口可以放到第二块屏幕或另一个浏览器窗口，只留下卡片和必要的字幕。
        </SectionHead>
        <Reveal y={48}><HowItWorks /></Reveal>
      </section>

      <div className="lp-features">
        <Feature id="chat" eyebrow="NATURAL LANGUAGE" title={<>像聊天一样，<br />把事情交代清楚</>} demo={<ChatDemo />}>
          <p>不需要学指令。说出要比较的方案、要记住的日子，或者问一句今天的天气，Vivic 判断你要的是什么，生成对应的卡片。</p>
          <p>普通闲聊也可以，回答会以一行字幕出现，不占画布。</p>
        </Feature>

        <Feature id="time" eyebrow="TIME, HANDLED" title={<>时间的事，<br />交给它记着</>} demo={<TimeDemo />} reverse>
          <p>说“倒计时 25 分钟”，展示窗口只留下跳动的数字；带事项的提醒会写清楚是什么、什么时候。</p>
          <p>到点后提醒退出画布，记录留在设置页里随时可查；生日、考试这类日子，用日期倒计时一直数下去。</p>
        </Feature>

        <Feature id="trust" eyebrow="GROUNDED BY DESIGN" title={<>数字有出处，<br />不替你编造</>} demo={<TrustDemo />}>
          <p>模型只给出经过校验的结构化数据，不执行代码。卡片里的数字、日期、链接和作者，必须能在你的原话、你给的网页或已有画布里找到；找不到就问你，而不是猜。</p>
          <p>联网搜索会标明来源。模型账号的凭据只留在本机后端内存里，不写进浏览器，也不进画布。</p>
        </Feature>

        <Feature id="hands" eyebrow="HANDS-ON CARDS" title={<>拖到手边，<br />随手就改</>} demo={<HandsOnDemo />} reverse>
          <p>展示窗口里的卡片可以拖到用户页：勾掉待办、调整进度、给习惯打卡、改日期、添加照片。改完再拖回展示窗口。</p>
          <p>每次修改都会重新校验，再同步到展示窗口。右边就是真实的卡片，可以直接试。</p>
        </Feature>

        <Feature id="ambience" eyebrow="EXPRESSIVE ENVIRONMENT" title={<>换一种氛围，<br />信息依然清楚</>} demo={<AmbienceDemo />}>
          <p>展示窗口、用户页和设置页共用“流光以太”动态背景，6 种深色、6 种浅色配色随时切换。</p>
          <p>背景负责氛围，卡片保持简洁——点一下右边的色块试试。</p>
        </Feature>
      </div>

      <section className="lp-statement">
        <InkText className="lp-display" text={"丰富的氛围，\n极简的信息。"} />
        <Reveal as="p" className="lp-statement-en" delay={0.08}>Expressive environment, minimal information.</Reveal>
        <Reveal delay={0.14}><a className="lp-button lp-button-soft" href="#scenes">看看所有卡片</a></Reveal>
      </section>

      <section className="closing lp-closing" id="join">
        <Reveal className="lp-closing-orb"><SiriOrb size="72px" animationDuration={20} /></Reveal>
        <Reveal as="h2" className="lp-display lp-closing-title" delay={0.05}>给正在做的事，<br />留一张清晰的画布。</Reveal>
        <Reveal as="p" className="lp-lede" delay={0.1}>从整理一份资料、开始一次专注，或者记下一个还没来得及展开的想法开始。</Reveal>
        <Reveal className="lp-closing-actions" delay={0.16}>
          <a className="lp-button lp-button-dark" href="#beta" onClick={focusBeta}>申请加入内测<ArrowRight size={16} aria-hidden /></a>
          <a className="lp-button lp-button-light local-link" href={APP_URL}>进入 VIVIC<ArrowUpRight size={16} aria-hidden /></a>
        </Reveal>
        <p className="lp-footnote">{APP_IS_LOCAL ? "已是内测用户？在本机启动 VIVIC 后，直接打开你的画布。" : "已是内测用户？直接打开你的画布。"}</p>
      </section>
    </main>
    <footer className="lp-footer">
      <Wordmark />
      <nav aria-label="页脚导航">{NAV.map(item => <a key={item.href} href={item.href}>{item.label}</a>)}</nav>
      <span>© 2026 VIVIC · 个人信息画布</span>
    </footer>
  </div>;
}
