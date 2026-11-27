// Trailer link helpers (src/utils/trailerLinks.ts; run: npm test in apps/mobile).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { localTrailer, trailerUrlsFor, youtubeId } from '../src/utils/trailerLinks.ts';

test('youtubeId reads the common YouTube link shapes', () => {
  assert.equal(youtubeId('https://www.youtube.com/watch?v=dQw4w9WgXcQ'), 'dQw4w9WgXcQ');
  assert.equal(youtubeId('https://youtube.com/watch?feature=share&v=dQw4w9WgXcQ'), 'dQw4w9WgXcQ');
  assert.equal(youtubeId('https://youtu.be/dQw4w9WgXcQ'), 'dQw4w9WgXcQ');
  assert.equal(youtubeId('https://www.youtube-nocookie.com/embed/dQw4w9WgXcQ?autoplay=1'), 'dQw4w9WgXcQ');
  assert.equal(youtubeId('https://www.youtube.com/shorts/dQw4w9WgXcQ'), 'dQw4w9WgXcQ');
  assert.equal(youtubeId('https://vimeo.com/123456'), null);
  assert.equal(youtubeId(null), null);
});

test('TVs ask the YouTube app first; phones keep the original link', () => {
  const url = 'https://www.youtube.com/watch?v=dQw4w9WgXcQ';
  assert.deepEqual(trailerUrlsFor(url, true), ['vnd.youtube:dQw4w9WgXcQ', 'https://www.youtube.com/watch?v=dQw4w9WgXcQ']);
  assert.deepEqual(trailerUrlsFor(url, false), [url]);
  assert.deepEqual(trailerUrlsFor('https://example.com/t.mp4', true), ['https://example.com/t.mp4']);
});

test('localTrailer picks the first trailer extra', () => {
  assert.equal(localTrailer([{ id: 'a', extraType: 'featurette' }, { id: 'b', extraType: 'trailer' }, { id: 'c', extraType: 'trailer' }])?.id, 'b');
  assert.equal(localTrailer([{ id: 'a', extraType: 'deleted' }]), null);
  assert.equal(localTrailer(undefined), null);
});
