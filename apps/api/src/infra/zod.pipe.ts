import { PipeTransform, Injectable, ArgumentMetadata } from "@nestjs/common";
import { z } from "zod";
import { ProblemException } from "./problem.js";

/** zod 校验失败 → 422 + issues（RFC 9457 的扩展成员），而不是一句笼统的 Bad Request。 */
@Injectable()
export class ZodPipe<T extends z.ZodType> implements PipeTransform {
  constructor(private readonly schema: T) {}
  transform(value: unknown, _meta: ArgumentMetadata): z.infer<T> {
    const r = this.schema.safeParse(value);
    if (r.success) return r.data;
    throw new ProblemException("validation-failed", {
      detail: "请求参数不符合契约",
      issues: r.error.issues.map(i => ({
        path: "/" + i.path.join("/"), message: i.message
      }))
    });
  }
}
export const zbody = <T extends z.ZodType>(s: T) => new ZodPipe(s);
