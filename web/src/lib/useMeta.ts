import { useEffect, useState } from "react";
import { api } from "../api/client";
import type { Meta } from "../api/types";

let cached: Meta | null = null;

/** Job-type registry + feature flags; fetched once per session. */
export function useMeta(): Meta | null {
  const [meta, setMeta] = useState<Meta | null>(cached);
  useEffect(() => {
    if (cached) return;
    api<Meta>("/meta")
      .then((m) => {
        cached = m;
        setMeta(m);
      })
      .catch(() => {});
  }, []);
  return meta;
}
