/** Server-side rollout switch; ingestion is not a claim that the page supports a lesson. */
export function webPageReviewEnabled() {
  return /^(true|1|yes|on)$/i.test(process.env.WEB_PAGE_REVIEW_ENABLED || "false");
}
