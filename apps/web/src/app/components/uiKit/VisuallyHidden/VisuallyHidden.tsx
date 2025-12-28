import { type PropsWithChildren } from "react";
import style from "./VisuallyHidden.module.css";

export default function VisuallyHidden(props: PropsWithChildren) {
  return <div className={style.visuallyHidden}>{props.children}</div>;
}
