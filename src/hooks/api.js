export async function api(path, method = 'GET', data) {
  const options = {
    method,
    credentials: 'same-origin'
  };
  if (data !== undefined) {
    options.headers = { 'Content-Type': 'application/json' };
    options.body = JSON.stringify(data);
  }
  const res = await fetch('/api' + path, options);
  let json = null;
  try {
    json = await res.json();
  } catch (e) {
    json = null;
  }
  if (!res.ok) {
    throw new Error((json && json.error) || 'Erreur API');
  }
  return json;
}
