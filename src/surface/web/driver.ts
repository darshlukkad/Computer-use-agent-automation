/**
 * Playwright implementation of the surface seam.
 *
 * This file, and only this file, is allowed to know what a browser is.
 *
 * The browser is owned from outside: the session must outlive any single replay so
 * a human can take control of the *same* live page during a handoff. A driver that
 * opened and closed its own browser per operation would make that impossible.
 */
import { chromium, type Browser, type BrowserContext, type Page } from "playwright";
import type { Target } from "../../artifact/schema.ts";
import {
  type ActRequest, type AxNode, type Observation, type Resolution, type SurfaceDriver,
} from "../driver.ts";
import { DIALOG_FN, HARVEST_FN } from "./axtree.ts";
import { countTarget, resolveTarget } from "./resolve.ts";

const MAX_NODES = 120;
const MAX_TEXT = 4000;

export interface WebDriverOptions {
  headed?: boolean;
  /** Run parameters, so locators may interpolate `${inputs.*}`. */
  inputs?: Record<string, string>;
  viewport?: { width: number; height: number };
  /** Delay between actions, for demonstrations. Not used in tests. */
  slowMoMs?: number;
  /** Record the session to this directory; the file lands on close(). */
  videoDir?: string;
}

export class WebDriver implements SurfaceDriver {
  readonly surface = "web";
  private browser: Browser | null = null;
  private context: BrowserContext | null = null;
  private page: Page | null = null;
  private inputs: Record<string, string>;

  constructor(private readonly opts: WebDriverOptions = {}) {
    this.inputs = opts.inputs ?? {};
  }

  /** Locators may reference run parameters; replay sets them before executing. */
  setInputs(inputs: Record<string, string>): void {
    this.inputs = inputs;
  }

  async launch(): Promise<Page> {
    if (this.page) return this.page;
    const viewport = this.opts.viewport ?? { width: 1280, height: 900 };
    this.browser = await chromium.launch({
      headless: !this.opts.headed,
      slowMo: this.opts.slowMoMs,
    });
    this.context = await this.browser.newContext({
      viewport,
      ...(this.opts.videoDir ? { recordVideo: { dir: this.opts.videoDir, size: viewport } } : {}),
    });
    this.page = await this.context.newPage();
    return this.page;
  }

  /** Path of the recorded video, available only after close(). */
  async videoPath(): Promise<string | null> {
    return (await this.page?.video()?.path()) ?? null;
  }

  /** Exposed for the handoff seam: a human drives this exact page. */
  livePage(): Page {
    if (!this.page) throw new Error("driver not launched");
    return this.page;
  }

  private p(): Page {
    if (!this.page) throw new Error("driver not launched");
    return this.page;
  }

  async url(): Promise<string> {
    return this.p().url();
  }

  async observe(): Promise<Observation> {
    const page = this.p();
    await page.waitForLoadState("domcontentloaded").catch(() => undefined);

    const nodes: AxNode[] = [];
    const dialogs: string[] = [];
    const chunks: string[] = [];

    for (const frame of page.frames()) {
      const label = frame.name() || (frame === page.mainFrame() ? "" : frame.url());
      try {
        const harvested = (await frame.evaluate(
          `(${HARVEST_FN})(${MAX_NODES})`,
        )) as AxNode[];
        for (const n of harvested) nodes.push(label ? { ...n, frame: label } : n);

        const found = (await frame.evaluate(`(${DIALOG_FN})()`)) as string[];
        dialogs.push(...found);

        chunks.push(await frame.locator("body").innerText({ timeout: 2000 }));
      } catch {
        // Detached or cross-origin frame; the rest of the page is still observable.
      }
    }

    return {
      url: page.url(),
      title: await page.title().catch(() => ""),
      nodes: nodes.slice(0, MAX_NODES),
      text: chunks.join("\n").replace(/\s+\n/g, "\n").slice(0, MAX_TEXT),
      dialogs: [...new Set(dialogs)],
    };
  }

  async resolve(target: Target): Promise<Resolution> {
    const { locator: _l, ...resolution } = await resolveTarget(this.p(), target, this.inputs);
    return resolution;
  }

  async count(target: Target): Promise<number> {
    return countTarget(this.p(), target, this.inputs);
  }

  async readText(target: Target): Promise<string> {
    const hit = await resolveTarget(this.p(), target, this.inputs);
    return (await hit.locator.innerText()).trim();
  }

  async readValue(target: Target): Promise<string> {
    const hit = await resolveTarget(this.p(), target, this.inputs);
    return (await hit.locator.inputValue()).trim();
  }

  async act(request: ActRequest): Promise<void> {
    const page = this.p();
    if (request.action === "navigate") {
      await page.goto(request.url, { waitUntil: "domcontentloaded" });
      return;
    }
    const hit = await resolveTarget(page, request.target, this.inputs);
    switch (request.action) {
      case "click": await hit.locator.click(); return;
      case "fill": await hit.locator.fill(request.value); return;
      case "select": await hit.locator.selectOption(request.value); return;
    }
  }

  async screenshot(path: string): Promise<void> {
    await this.p().screenshot({ path, fullPage: false });
  }

  /**
   * Cookies and storage only — the page, and therefore the handoff seam, survives.
   * Closing the context here would destroy the very session a human may be about to
   * take control of.
   */
  async clearSession(): Promise<void> {
    await this.context?.clearCookies();
    await this.p().evaluate(() => {
      try { localStorage.clear(); sessionStorage.clear(); } catch { /* file:// or opaque origin */ }
    }).catch(() => undefined);
  }

  async close(): Promise<void> {
    await this.context?.close().catch(() => undefined);
    await this.browser?.close().catch(() => undefined);
    this.browser = null;
    this.context = null;
    this.page = null;
  }
}
