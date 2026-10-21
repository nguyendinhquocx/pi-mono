import { APP_NAME } from "../../config.ts";
import type { LiToolOutputStyle } from "../../core/settings-schema.ts";

let liToolOutputStyle: LiToolOutputStyle = "blank";

export function setLiToolOutputStyle(style: LiToolOutputStyle): void {
	liToolOutputStyle = style;
}

export function isLiToolOutputBlank(): boolean {
	return APP_NAME === "li" && liToolOutputStyle === "blank";
}
