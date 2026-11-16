// Chrome collection moved to @ktb/kernel (P-060 follow-up): plugins that
// render their own chrome regions (e.g. the dashboard's page slots) need
// `collectChrome`, and plugins may not import @ktb/app-host. This shim
// keeps the app-host/client surface stable for apps.
export {
	KNOWN_CHROME_REGIONS,
	chromeWhenMatches,
	collectChrome,
	unknownChromeRegions,
	warnUnknownChromeRegions,
} from "@ktb/kernel";
