#!/usr/bin/env bash
# Store screenshots from the NATIVE apps (iPhone, iPad, Apple TV, Android phone, Android TV / Fire TV), taken
# against the review server so only the rights-free review pack is on screen.
#
# The Samsung / LG / VIDAA apps show the web app in TV mode, which store-shots.mjs captures headless. The Expo apps
# are native (React Native), so their screenshots have to come from a simulator, an emulator or a device:
#
#   1. Start the review server (docs/APP_REVIEW.md) and install a release build of the app on the simulator/emulator.
#   2. Open the app once, connect to the review server and sign in with the review account by hand.
#   3. Run:  REVIEW_URL=https://kinora-review.example.com REVIEW_USERNAME=appreview REVIEW_PASSWORD=... \
#              scripts/review-pack/native-shots.sh ios|ipad|tvos|android|androidtv  [out-dir]
#
# Uses deep links (kinora://item/<id>, kinora://library/<id>, kinora://live/guide) to open each screen, waits, and
# saves a PNG. Simulators: iPhone 17 Pro gives 1206×2622 (Apple's required "iPhone with Dynamic Island (medium
# display)" size), iPad Pro 13-inch gives 2064×2752, Apple TV 4K gives 3840×2160. Needs curl, node (for JSON), and
# xcrun (macOS) or adb.
#
# Not run in CI and not tested on this branch's build machine (no simulator there): check every image before upload.
set -euo pipefail

target="${1:?usage: native-shots.sh ios|ipad|tvos|android|androidtv [out-dir]}"
out="${2:-docs/store/screenshots/native-$target}"
: "${REVIEW_URL:?set REVIEW_URL}" "${REVIEW_USERNAME:?set REVIEW_USERNAME}" "${REVIEW_PASSWORD:?set REVIEW_PASSWORD}"
mkdir -p "$out"
wait_s="${WAIT_SECONDS:-4}"

json() { node -e "let s='';process.stdin.on('data',d=>s+=d).on('end',()=>{const j=JSON.parse(s);console.log(($1)(j)??'')})"; }
token=$(curl -sf -H 'content-type: application/json' -H 'X-Kinora-Device-Id: native-shots' \
  -d "{\"username\":\"$REVIEW_USERNAME\",\"password\":\"$REVIEW_PASSWORD\"}" "$REVIEW_URL/api/v1/auth/login" | json 'j=>j.token')
api() { curl -sf -H "Authorization: Bearer $token" "$REVIEW_URL/api/v1$1"; }
item() { api "/items?type=$1&limit=100" | TITLE="$2" json 'j=>(j.items.find(i=>i.title===process.env.TITLE)||{}).id'; }
lumen=$(item movie 'Lumen'); aurora=$(item movie 'Aurora Drift'); show=$(item show 'Pixel Tides'); album=$(item album 'First Light')
photos=$(api /libraries | json "j=>(j.find(l=>l.type==='photos')||{}).id")

open_link() {
  case "$target" in
    ios|ipad|tvos) xcrun simctl openurl booted "$1" ;;
    android|androidtv) adb shell am start -W -a android.intent.action.VIEW -d "$1" >/dev/null ;;
  esac
}
snap() {
  case "$target" in
    ios|ipad|tvos) xcrun simctl io booted screenshot --type=png "$out/$1.png" >/dev/null ;;
    android|androidtv) adb exec-out screencap -p > "$out/$1.png" ;;
  esac
  echo "  $out/$1.png"
}
shot() { open_link "$2"; sleep "$wait_s"; snap "$1"; }

if [ "$target" = ios ] || [ "$target" = ipad ]; then
  xcrun simctl status_bar booted override --time 9:41 --batteryState charged --batteryLevel 100 --wifiBars 3 --cellularBars 4 || true
fi
echo "Capturing $target into $out"
shot 01-home "kinora://"
shot 02-movie-4k-hdr "kinora://item/$lumen"
shot 03-series "kinora://item/$show"
shot 04-player "kinora://player/$aurora"
shot 05-music "kinora://item/$album"
[ -n "$photos" ] && shot 06-photos "kinora://library/$photos"
shot 07-live-guide "kinora://live/guide"
if [ "$target" = ios ] || [ "$target" = ipad ]; then xcrun simctl status_bar booted clear || true; fi
echo "Done. Look at every image before uploading (no personal data, no notifications, the review server's name only)."
