import { expect, type Page } from "@playwright/test";

/** Every interactive control has an accessible name; one h1; no inline style attributes (CSP). */
export async function a11yBasics(page: Page): Promise<void> {
  const issues = await page.evaluate(() => {
    const out: string[] = [];
    for (const el of document.querySelectorAll<HTMLElement>("button, a[href], input, select, [role=combobox]")) {
      const label =
        el.getAttribute("aria-label") ||
        el.getAttribute("aria-labelledby") ||
        (el.id && document.querySelector(`label[for="${el.id}"]`)?.textContent) ||
        el.textContent?.trim() ||
        el.getAttribute("title");
      if (!label && el.getAttribute("type") !== "hidden" && el.getAttribute("aria-hidden") !== "true")
        out.push(el.outerHTML.slice(0, 120));
    }
    if (document.querySelectorAll("h1").length !== 1) out.push(`h1 count ${document.querySelectorAll("h1").length}`);
    if (document.querySelector("[style]")) out.push("inline style attribute");
    return out;
  });
  expect(issues).toEqual([]);
}
