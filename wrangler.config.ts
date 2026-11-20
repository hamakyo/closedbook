import { defineWranglerConfig } from "wrangler/experimental-config";

export default defineWranglerConfig({
	rules: [
		{
			type: "Text",
			globs: [
				"**/*.html",
			],
			fallthrough: true,
		},
		{
			type: "Text",
			globs: [
				"**/*.css",
			],
			fallthrough: true,
		},
	],
});
