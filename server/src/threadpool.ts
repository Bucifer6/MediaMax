/**
 * A bigger libuv thread pool (default: 4 threads). Every asynchronous filesystem call holds one thread until the OS
 * answers, and a sleeping NAS or an SMB share whose PC is asleep doesn't answer for a minute or more. With 4 threads,
 * a scan or watcher waiting on such a share took them all: static files, HLS segments and every other fs call then
 * queued behind it, so pages took minutes to load and streams timed out although the event loop was free.
 *
 * libuv reads this when the pool first starts, so this module is imported before anything else. An explicit
 * UV_THREADPOOL_SIZE (environment) wins. Idle threads cost almost nothing.
 */
if (!process.env.UV_THREADPOOL_SIZE) process.env.UV_THREADPOOL_SIZE = '64';
