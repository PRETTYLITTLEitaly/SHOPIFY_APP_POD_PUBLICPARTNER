import PDFDocument from "pdfkit";
import SVGtoPDF from "svg-to-pdfkit";

const MM_TO_PT = 2.83465;
const PADDING_MM = 3; 
const LABEL_HEIGHT_MM = 5; 

// Bin Packing Algorithm: Shelf Next Fit with improvement or MaxRects-style logic
export async function generatePodPdf(items, binWidthMm = 300) {
  return new Promise((resolve, reject) => {
    try {
      const binWidthPt = binWidthMm * MM_TO_PT;
      const paddingPt = PADDING_MM * MM_TO_PT;
      const labelHeightPt = LABEL_HEIGHT_MM * MM_TO_PT;
      
      // Sort by height descending to optimize "shelves"
      const sortedItems = [...items].sort((a, b) => b.heightMm - a.heightMm);
      
      const boxes = [];
      let currentX = paddingPt;
      let currentY = paddingPt;
      let shelfHeightPt = 0;

      for (const item of sortedItems) {
        let w = item.widthMm * MM_TO_PT;
        let h = item.heightMm * MM_TO_PT;
        let rotated = false;

        // Smart Rotation: if rotating 90deg fits better or is necessary
        if (w > (binWidthPt - 2 * paddingPt) || (h < w && w > (binWidthPt / 2))) {
           // Swap if it helps fit or saves vertical space in a wide bin
           const temp = w;
           w = h;
           h = temp;
           rotated = true;
        }

        const totalItemH = h + labelHeightPt;
        const totalItemW = w;

        // If it doesn't fit horizontally, move to next shelf
        if (currentX + totalItemW + paddingPt > binWidthPt) {
          currentX = paddingPt;
          currentY += shelfHeightPt + paddingPt;
          shelfHeightPt = 0;
        }

        boxes.push({
          ...item,
          x: currentX,
          y: currentY,
          w: w,
          h: h,
          totalH: totalItemH,
          rotated: rotated
        });

        currentX += totalItemW + paddingPt;
        shelfHeightPt = Math.max(shelfHeightPt, totalItemH);
      }

      const totalHeightPt = currentY + shelfHeightPt + paddingPt;
      const doc = new PDFDocument({ size: [binWidthPt, totalHeightPt], margin: 0 });
      const chunks = [];

      doc.on("data", (chunk) => chunks.push(chunk));
      doc.on("end", () => resolve(Buffer.concat(chunks)));
      doc.on("error", (err) => reject(err));

      for (const box of boxes) {
        if (box.svgContent) {
          try {
            doc.save();
            // Move to the position
            doc.translate(box.x, box.y);
            
            if (box.rotated) {
              // Rotate around center or top-left
              doc.rotate(90, { origin: [box.w / 2, box.w / 2] });
              // Adjustment might be needed depending on SVG anchor
            }

            // Since rotation can be complex with SVGtoPDF anchors, 
            // we use a simpler approach: if rotated, we swapped W/H already
            // and we tell SVGtoPDF the NEW bounding box
            SVGtoPDF(doc, box.svgContent, 0, 0, {
              width: box.w,
              height: box.h,
              preserveAspectRatio: "xMidYMid meet"
            });
            
            doc.restore();
          } catch (svgErr) {
            console.error("SVG RENDER ERROR:", svgErr);
            doc.rect(box.x, box.y, box.w, box.h).stroke();
          }
        } else {
          doc.rect(box.x, box.y, box.w, box.h).stroke();
        }

        // Draw Label below
        doc.fillColor("black")
           .fontSize(7)
           .text(`${box.orderName}${box.rotated ? ' (R)' : ''}`, box.x, box.y + box.h + 1, {
             width: box.w,
             align: "center"
           });
      }

      doc.end();
    } catch (e) {
      reject(e);
    }
  });
}
