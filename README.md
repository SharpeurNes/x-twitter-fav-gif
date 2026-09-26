# X/Twitter GIF Favorites

A Tampermonkey userscript that lets you save GIFs you find on X (Twitter) and repost them later with one click.

Download: https://github.com/SharpeurNes/x-twitter-fav-gif/raw/refs/heads/main/x-twitter-fav-gif.user.js

## What it does

1. **Star a GIF** — A small star button appears on top of every GIF in your timeline. Click it to save that GIF.
2. **Real conversion** — The script downloads the GIF (which X actually stores as an `.mp4` video internally) and converts it into a real animated `.gif` file, right in your browser. This takes a few seconds.
3. **Local storage** — The converted GIF is saved on your device (via Tampermonkey's storage). Nothing is uploaded anywhere else. Un-starring a GIF deletes it from storage.
4. **Repost it** — A matching star icon is added to the toolbar of every tweet/reply box (next to the flag icon). Clicking it opens your GIF collection; clicking a GIF there attaches it to the tweet/reply you're writing.

## Installation

1. Install the [Tampermonkey](https://www.tampermonkey.net/) browser extension.
2. Open Tampermonkey's dashboard → **Create a new script**.
3. Delete the placeholder code and paste in the contents of `x-gif-favoris.user.js`.
4. Save (Ctrl+S). Reload x.com.

## How to use it

- **Save a GIF:** hover any GIF in your feed, click the star in its top-left corner. Wait for the "converted and saved" toast.
- **Remove a GIF:** click the same star again (it's now filled yellow) — this deletes the saved file too.
- **Post a saved GIF:** open a tweet or reply box, click the star icon in the toolbar (after the flag icon). Your saved GIFs appear in a small panel. Click one to attach it.
- **Delete everything:** open the panel and use "Clear all".
- **No compose box open?** Use the Tampermonkey menu (click the extension icon → *"Voir mes GIFs favoris"*) to browse/manage your collection anytime.

## Good to know

- **Conversion quality:** true GIFs only support 256 colors, so converted clips look slightly less smooth than the original video — that's an inherent GIF limitation, not a bug.
- **Size limit:** X rejects GIF uploads over 15 MB. The script automatically caps resolution (480px wide) and frame count to stay under that in most cases.
- **Storage:** each saved GIF takes a few hundred KB to a couple MB of local browser storage. A very large collection could eventually hit browser storage limits — use "Clear all" if that happens.
- **If it stops working:** X updates its website regularly, which can break the exact spots the script looks for (the toolbar, the GIF badge, etc.). If the star buttons disappear, the script likely needs a small update to match X's new page structure.
