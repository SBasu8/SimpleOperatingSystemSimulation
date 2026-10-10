// Runs the optimizer off the main thread so the map keeps animating while it solves.
importScripts('optimizer.js');

self.onmessage = (e) => {
  const { id, payload } = e.data;
  try {
    self.postMessage({ id, result: self.solveDispatch(payload) });
  } catch (err) {
    self.postMessage({ id, error: err.message || String(err) });
  }
};
