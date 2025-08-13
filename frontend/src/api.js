export default async function api(path, method = 'GET', data) {
  const opts = { method, headers: { 'Content-Type': 'application/json' } };
  if (data) {
    opts.body = JSON.stringify(data);
  }
  const res = await fetch(`/api${path}`, opts);
  if (!res.ok) {
    throw new Error(await res.text());
  }
  const ct = res.headers.get('content-type') || '';
  if (ct.includes('application/json')) {
    return await res.json();
  }
  return null;
}
