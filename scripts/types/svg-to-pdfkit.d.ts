declare module "svg-to-pdfkit" {
  import type PDFDocument from "pdfkit";

  interface SVGtoPDFOptions {
    width?: number;
    height?: number;
    preserveAspectRatio?: string;
    useCSS?: boolean;
    [key: string]: unknown;
  }

  function SVGtoPDF(doc: PDFDocument, svg: string, x: number, y: number, options?: SVGtoPDFOptions): void;

  export default SVGtoPDF;
}
