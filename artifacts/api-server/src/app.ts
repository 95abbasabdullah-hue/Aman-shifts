import express, { type Express } from "express";
import cors from "cors";
import { clerkMiddleware } from "@clerk/express";
import { publishableKeyFromHost } from "@clerk/shared/keys";
import pinoHttp from "pino-http";
import router from "./routes";
import { logger } from "./lib/logger";
import {
  CLERK_PROXY_PATH,
  clerkProxyMiddleware,
  getClerkProxyHost,
} from "./middlewares/clerkProxyMiddleware";

const app: Express = express();
const allowedOrigins = new Set(
  (process.env.AMAN_ALLOWED_ORIGINS ?? "")
    .split(",")
    .map((origin) => origin.trim())
    .filter(Boolean)
    .map((origin) => {
      const parsed = new URL(origin);
      if (parsed.pathname !== "/" || parsed.search || parsed.hash) {
        throw new Error("AMAN_ALLOWED_ORIGINS entries must be origins without paths.");
      }
      if (process.env.NODE_ENV === "production" && parsed.protocol !== "https:") {
        throw new Error("AMAN_ALLOWED_ORIGINS entries must use HTTPS in production.");
      }
      return parsed.origin;
    }),
);
const apiCors = cors({
  origin(origin, callback) {
    callback(null, !origin || allowedOrigins.has(origin));
  },
  methods: ["GET", "POST", "PUT", "PATCH", "DELETE", "OPTIONS"],
  allowedHeaders: ["Accept", "Authorization", "Content-Type"],
  maxAge: 600,
});
const noStoreApiResponses: express.RequestHandler = (_req, res, next) => {
  res.setHeader("Cache-Control", "no-store, private");
  next();
};

app.use(
  pinoHttp({
    logger,
    serializers: {
      req(req) {
        return {
          id: req.id,
          method: req.method,
          url: req.url?.split("?")[0],
        };
      },
      res(res) {
        return {
          statusCode: res.statusCode,
        };
      },
    },
  }),
);

app.use(CLERK_PROXY_PATH, noStoreApiResponses, apiCors, clerkProxyMiddleware());

app.use(express.json());
app.use(express.urlencoded({ extended: true }));

app.use(
  clerkMiddleware((req) => ({
    publishableKey: publishableKeyFromHost(
      getClerkProxyHost(req) ?? "",
      process.env.CLERK_PUBLISHABLE_KEY,
    ),
  })),
);

app.use("/api", noStoreApiResponses, apiCors, router);

export default app;
