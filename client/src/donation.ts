export const DONATE_URL = "https://ricos.site/donate?from=asteroids";

const SUPPORTED_PARAM = "supported";
const SUPPORTED_AT_KEY = "donation-supported-at";

// The ricos.site donate page sends donors back to /?supported=1. Store when that
// happened (a future inline ask stays quiet for a while after it) and drop the
// parameter so a reload or shared link doesn't re-trigger it.
export const recordDonationSupport = (win: Window = window): void => {
  const url = new URL(win.location.href);
  if (url.searchParams.get(SUPPORTED_PARAM) !== "1") return;

  try {
    win.localStorage.setItem(SUPPORTED_AT_KEY, String(Date.now()));
  } catch {
    // Storage can be blocked (private mode, disabled site data); still clean the URL.
  }

  url.searchParams.delete(SUPPORTED_PARAM);
  win.history.replaceState(win.history.state, "", `${url.pathname}${url.search}${url.hash}`);
};
