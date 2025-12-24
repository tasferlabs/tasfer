import { type Dispatch, type SetStateAction, useEffect, useState } from "react";

const useLocalStorage = <T>(
  key: string,
  initialValue?: T
): [T | undefined, Dispatch<SetStateAction<T>>] => {
  const isClient = typeof window !== "undefined";

  if (!isClient) {
    return [initialValue as T, () => {}];
  }
  if (!key) {
    throw new Error("useLocalStorage key may not be falsy");
  }
  const [data, setData] = useState<T>(
    JSON.parse(localStorage.getItem(key) ?? JSON.stringify(initialValue)) ??
      initialValue
  );

  useEffect(() => {
    localStorage.setItem(key, JSON.stringify(data));
  }, [data, key]);

  return [data, setData];
};

export default useLocalStorage;
