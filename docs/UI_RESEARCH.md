# Kinora: research-informed UI and brand proposal

Review date: 23 November 2026. Proposed on the UI review branch; not approved for main or deployment.

## Method and limits

Desk research across first-hand Plex community feedback, Plex support documentation, Jellyfin release notes, a Jellyfin enhancement project and WCAG guidance. These are qualitative signals, not interviews with Kinora users, a representative survey, or evidence of market-wide preference. Complaints in support forums are especially prone to selection bias. No popularity percentages or conversion claims are inferred.

## Findings and decisions

| Signal | Evidence | Kinora response |
|---|---|---|
| Getting back to an unfinished title should take very few steps. | [Plex users describe extra navigation to resume viewing](https://forums.plex.tv/t/new-interface-is-much-more-work-fo-continue-watching/931793). | Continue Watching and Next Up precede the feature on desktop/phone by default. Existing resume handlers are retained. |
| Attractive changes are unwelcome when familiar controls disappear or navigation slows down. | [October 2026 Plex feedback](https://forums.plex.tv/t/new-interface-not-ready/943765) calls out latency and missing playback controls. | Keep labeled navigation, all existing destinations and playback controls. Reduce decorative space and ambient effects on Home. Playback reliability remains a priority beyond this visual review. |
| People need control over what occupies Home. | [Plex recommendation management](https://support.plex.tv/articles/manage-recommendations/) exposes row controls; [KefinTweaks](https://github.com/ranaldsgift/KefinTweaks) implements customizable Home, watchlists and appearance controls. | Add a per-device Resume first / Browse first choice, remembered locally. The latter retains server-configured browsing order. Existing Branding Studio controls continue to determine available rows. |
| Useful details and predictable playback matter alongside visuals. | [Jellyfin Android TV 0.20](https://jellyfin.org/posts/androidtv-v0.20.0/) highlights clearer settings, format badges, external playback progress and control over Next Up age. | Preserve metadata, format indicators and progress. Do not replace working playback flows as part of a colour/logo change. Preserve the current TV presentation. |
| Motion needs a usable off/pause path, and targets and contrast need checking. | [WCAG 2.2](https://www.w3.org/TR/WCAG22/), especially 1.4.3, 2.2.2 and 2.5.8. | Keep carousel pause and reduced-motion handling; check the new theme colours, focus states and phone-width controls. This is not a claim of full WCAG conformance. |

## Proposed identity: Screenlight

This is a design judgement, not a colour preference established by the research. Graphite puts media artwork ahead of the interface; mint identifies actions and selected navigation. A warm sand accent is reserved for secondary emphasis. A mint K made from a vertical strip and two angled frames replaces the previous multicolour projector-beam mark. It uses one silhouette at small and large sizes, has a darker teal light-background version, and works in one colour.

| Role | Dark | Light |
|---|---|---|
| Background | `#101416` | `#F4F8F6` |
| Surface | `#191F22` | `#FFFFFF` |
| Primary | `#63DEC5` | `#137665` |
| Text | `#F2F6F4` | `#162321` |
| Secondary text | `#A7B6B1` | `#52655F` |
| Accent | `#DFBF86` | `#836126` |

The Kinora name and typography remain. Existing theme identifiers, custom themes, uploaded branding and app identifiers remain compatible. Generated web, mobile and TV assets derive from the same mark source.

## Follow-up research before a broad rollout

Test with a few actual Kinora viewers, including someone who did not set up the server: resume a film, find the next episode, browse a library, search, change subtitles, and switch profile. Compare completion time, wrong turns and subjective preference against the first design. Test phone touch, keyboard and a physical TV remote. Ask whether Resume first should be a profile preference shared across devices; the proposal currently keeps it per device.

Candidate follow-ups, not implemented here: hiding individual titles from Continue Watching while retaining progress; a unified ongoing-series row; better persistence of browsing position; playback diagnostics and subtitle discoverability. Each needs Kinora-specific validation and separate functional scope.
