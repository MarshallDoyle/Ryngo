// Polyglot edge: TS side. The literal "/widgets/" + id is the URL fetched;
// the polyglot adapter must match it to the Python `@router.get("/widgets/{widget_id}")`
// declaration in api.py.

export async function fetchWidget(id: string): Promise<unknown> {
  const res = await fetch("/widgets/" + id);
  return res.json();
}
