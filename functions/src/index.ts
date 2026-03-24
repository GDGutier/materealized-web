import {onRequest} from "firebase-functions/v2/https";
import {setGlobalOptions} from "firebase-functions/v2/options";

setGlobalOptions({maxInstances: 10, region: "us-central1"});

const BASE = "https://generativelanguage.googleapis.com" +
  "/v1beta";

interface Adjacent {
  position: string;
  image: string;
  mimeType: string;
}

interface Part {
  text?: string;
  inlineData?: { data: string; mimeType: string };
}

/**
 * Call Gemini with multimodal parts.
 * @param {string} apiKey - API key.
 * @param {string} model - Model name.
 * @param {Part[]} parts - Content parts.
 * @param {string[]} mods - Response modalities.
 * @return {Promise<Record<string, unknown>>} Resp.
 */
async function callGemini(
  apiKey: string,
  model: string,
  parts: Part[],
  mods: string[]
): Promise<Record<string, unknown>> {
  const url = `${BASE}/models/${model}` +
    `:generateContent?key=${apiKey}`;

  const body = {
    contents: [{parts}],
    generationConfig: {
      responseModalities: mods,
    },
  };

  const res = await fetch(url, {
    method: "POST",
    headers: {"Content-Type": "application/json"},
    body: JSON.stringify(body),
  });

  if (!res.ok) {
    const err = await res.text();
    throw new Error(`${model}: ${err}`);
  }

  return res.json();
}

export const generateMemory = onRequest(
  {
    cors: true,
    secrets: ["GEMINI_API_KEY"],
    timeoutSeconds: 120,
    memory: "1GiB",
  },
  async (req, res) => {
    if (req.method !== "POST") {
      res.status(405).send("Method not allowed");
      return;
    }

    const {prompt, adjacentImages} = req.body;
    if (!prompt || typeof prompt !== "string") {
      res.status(400).send("Missing prompt");
      return;
    }

    try {
      const apiKey =
        process.env.GEMINI_API_KEY || "";

      // Build multimodal parts
      const parts: Part[] = [];

      // If we have adjacent images, include them
      const adj = (adjacentImages || []) as Adjacent[];
      if (adj.length > 0) {
        let ctx = "You are filling one cell in a " +
          "grid of images that together form a " +
          "single scene. Here are the adjacent " +
          "cells. DO NOT recreate or duplicate " +
          "the objects in them. Instead, generate " +
          "ONLY the new requested subject, but " +
          "match the lighting, color palette, " +
          "and spatial perspective so it looks " +
          "like a continuation of the same room. " +
          "Positions of neighbors: ";
        ctx += adj.map((a: Adjacent) =>
          a.position).join(", ") + ". ";
        parts.push({text: ctx});

        for (const a of adj) {
          parts.push({
            text: `[${a.position}]:`,
          });
          parts.push({
            inlineData: {
              data: a.image,
              mimeType: a.mimeType,
            },
          });
        }
      }

      // Main prompt
      parts.push({
        text: `Generate: ${prompt}. ` +
          "Photorealistic, detailed. " +
          "On a solid bright green (#00FF00) " +
          "chroma-key background. " +
          "Only the subject, nothing extra. " +
          "Square 1:1.",
      });

      const attempts = [
        {model: "gemini-2.5-flash-image",
          mods: ["IMAGE"]},
        {model: "gemini-2.5-flash-image",
          mods: ["TEXT", "IMAGE"]},
      ];

      let data: Record<string, unknown> | null =
        null;
      const errors: string[] = [];

      for (const attempt of attempts) {
        try {
          data = await callGemini(
            apiKey,
            attempt.model,
            parts,
            attempt.mods
          );
          const c = (data as {
            candidates?: Array<{
              content?: {parts?: Array<{
                inlineData?: {data?: string};
              }>};
            }>;
          }).candidates;
          const hasImg = c?.[0]?.content
            ?.parts?.some(
              (p) => !!p.inlineData?.data
            );
          if (hasImg) break;
          data = null;
          errors.push(
            `${attempt.model}: no image`
          );
        } catch (e: unknown) {
          const msg = e instanceof Error ?
            e.message : String(e);
          errors.push(msg);
        }
      }

      if (!data) {
        res.status(500).json({
          error: errors.join(" | "),
        });
        return;
      }

      let imageData: string | null = null;
      let mimeType = "image/png";

      const candidates = (data as {
        candidates?: Array<{
          content?: {parts?: Array<{
            inlineData?: {
              data?: string;
              mimeType?: string;
            };
          }>};
        }>;
      }).candidates;

      if (candidates?.[0]) {
        const rParts =
          candidates[0].content?.parts || [];
        for (const part of rParts) {
          if (part.inlineData?.data) {
            imageData = part.inlineData.data;
            mimeType =
              part.inlineData.mimeType ||
              "image/png";
            break;
          }
        }
      }

      if (!imageData) {
        res.status(500).json({
          error: "No image extracted",
        });
        return;
      }

      // Generate depth map from the image
      let depthData: string | null = null;
      let depthMime = "image/png";
      try {
        const depthParts: Part[] = [
          {text: "Generate a grayscale depth map " +
            "of this image. White = close to " +
            "camera, black = far away. " +
            "Output only the depth map image, " +
            "no text."},
          {inlineData: {
            data: imageData, mimeType,
          }},
        ];
        const depthRes = await callGemini(
          apiKey,
          "gemini-2.5-flash-image",
          depthParts,
          ["IMAGE"]
        );
        const dc = (depthRes as {
          candidates?: Array<{
            content?: {parts?: Array<{
              inlineData?: {
                data?: string;
                mimeType?: string;
              };
            }>};
          }>;
        }).candidates;
        if (dc?.[0]) {
          const dp = dc[0].content?.parts || [];
          for (const p of dp) {
            if (p.inlineData?.data) {
              depthData = p.inlineData.data;
              depthMime =
                p.inlineData.mimeType ||
                "image/png";
              break;
            }
          }
        }
      } catch (e) {
        console.log("Depth map failed:", e);
      }

      const result: Record<string, string> = {
        image: imageData, mimeType,
      };
      if (depthData) {
        result.depthMap = depthData;
        result.depthMimeType = depthMime;
      }
      res.json(result);
    } catch (error: unknown) {
      const msg = error instanceof Error ?
        error.message : "Unknown error";
      console.error("Generation error:", msg);
      res.status(500).json({error: msg});
    }
  }
);
