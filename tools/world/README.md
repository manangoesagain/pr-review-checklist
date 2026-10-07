# The landing page's world

The landing page (`public/index.html`) is a scroll-driven flight through a miniature
world: a pull request travels a road past one island per review area and arrives at a
giant checklist. Scrolling scrubs pre-recorded video, using the scroll engine from
[scroll-world](https://github.com/oso95/scroll-world) (MIT, copied to
`public/vendor/scroll-world`).

scroll-world normally makes its scenes with paid AI video tools. Here the world is
drawn with plain [three.js](https://threejs.org) shapes instead (`world.js`), and
`render.mjs` records it frame by frame in a headless browser. Because every clip is cut
from one continuous camera path, the last frame of each clip is exactly the first frame
of the next, which is the seam rule scroll-world asks for. The path also keeps the
camera's speed and direction continuous across each seam, and the page scrolls every
clip at the same rate, so the flight never stops and starts between clips.

You only need this to change the world. The recorded clips are already in `public/world`.

```bash
cd tools/world
npm install
npx playwright install chromium
npm run render
```

That records the desktop clips (1920x1080) and the phone clips (720x1280, named `-m`)
at 30 frames a second, plus a still of each scene's first frame. Each clip is saved
twice, as H.264 MP4 and VP9 WebM; the page plays the WebM where the browser supports it
and the MP4 elsewhere. Recording takes one to two hours on a laptop without a graphics
card. If it stops, run it again and it continues where it left off (saved frames are
only reused while `world.js` is unchanged).
