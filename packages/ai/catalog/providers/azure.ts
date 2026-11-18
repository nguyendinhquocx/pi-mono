import type { Model, ModelCost } from "../../src/types.ts";
import { type ChatModel, defineProvider, mergeCompat, modelsDevModels } from "../define.ts";
import {
	enableOpenAiGrammarTools,
	OPENAI_LONG_CONTEXT_INPUT_THRESHOLD,
	OPENAI_STANDARD_COSTS,
	withOpenAiLongContextPricing,
} from "../families/openai.ts";

// Azure Foundry deploys these with larger context windows than OpenAI's own short-tier defaults.
// See models-sold-directly-by-azure docs.
const CONTEXT_WINDOW_OVERRIDES: Record<string, number> = {
	"gpt-5.4": 1050000,
	"gpt-5.5": 1050000,
	"gpt-5.6-luna": 1050000,
	"gpt-5.6-sol": 1050000,
	"gpt-5.6-terra": 1050000,
	"gpt-6-astra": 1050000,
	"gpt-6-luna": 1050000,
	"gpt-6-sol": 1050000,
	"gpt-6.1-sol": 1050000,
	"gpt-6.1-terra": 1050000,
	"gpt-6.2-astra": 1050000,
	"gpt-6.2-sol": 1050000,
};

// Azure resells DeepSeek at its own rates. US data zone, checked 2026-09-16.
// https://azure.microsoft.com/en-us/pricing/details/ai-foundry-models/deepseek/
const DEEPSEEK_V4_PRO_COST: ModelCost = { input: 1.925, output: 3.828, cacheRead: 0.165, cacheWrite: 0 };

/** OpenAI models as Azure deploys them, including OpenAI's long-context price tier above 272K input tokens. */
function openAiModels(models: ChatModel[]): ChatModel[] {
	return models
		.filter((model) => model.api === "openai-responses")
		.map((model) => ({
			...model,
			api: "azure-openai-responses",
			provider: "azure",
			baseUrl: "",
			contextWindow: CONTEXT_WINDOW_OVERRIDES[model.id] ?? model.contextWindow,
		}));
}

export default defineProvider({
	id: "azure",
	models: (ctx) => [
		...openAiModels(ctx.providerModels("openai")),
		// Azure Foundry serves gpt-6.1-terra even though Li hides it from direct api.openai
		// (owner request keeps direct-OpenAI catalog clean; Azure clone re-derives it from models.dev).
		...openAiModels(
			modelsDevModels(ctx, "openai", {
				api: "openai-responses",
				baseUrl: "https://api.openai.com/v1",
				protocol: "responses",
				include: (source) => source.id === "gpt-6.1-terra",
				map: (model) => ({
					...model,
					provider: "openai",
					contextWindow: OPENAI_LONG_CONTEXT_INPUT_THRESHOLD,
					maxTokens: 128000,
					cost: withOpenAiLongContextPricing(OPENAI_STANDARD_COSTS["gpt-6.1-terra"]),
				}),
			}),
		),
		...ctx
			.providerModels("deepseek")
			.filter((model) => model.id === "deepseek-v4-pro")
			.map((model) => ({ ...model, provider: "azure", baseUrl: "", cost: DEEPSEEK_V4_PRO_COST })),
	],
	compat: { "openai-completions": { supportsStrictMode: true } },
	finalize: (model) => {
		enableOpenAiGrammarTools(model);
		if (model.api === "openai-completions") {
			// Azure 400s on DeepSeek's `thinking` field and on every prompt cache parameter, discards a
			// `developer` system message unbilled once reasoning_effort is set, and honours mid-convo ones (#9645).
			mergeCompat(model as Model<"openai-completions">, {
				supportsDeveloperRole: false,
				supportsMidConvoSystemMessages: true,
				thinkingFormat: "openai",
				supportsLongCacheRetention: false,
			});
		}
	},
});
