const destination = 'https://app.aspectlylabs.com/mikka'

export default {
  fetch(request) {
    if (request.method === 'GET' || request.method === 'HEAD') {
      return new Response(null, {
        status: 302,
        headers: { location: destination, 'cache-control': 'no-store' },
      })
    }
    return new Response(`Gone. Visit ${destination}\n`, {
      status: 410,
      headers: { 'content-type': 'text/plain; charset=utf-8', 'cache-control': 'no-store' },
    })
  },
}
