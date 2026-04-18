import PDFDocument from "pdfkit";
import SVGtoPDF from "svg-to-pdfkit";
import fs from "fs";
import path from "path";

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

      // REGISTRAZIONE FONT DINAMICA (v1.4.0)
      const fontDir = path.join(process.cwd(), "public", "fonts");
      let availableFonts = [];
      if (fs.existsSync(fontDir)) {
        availableFonts = fs.readdirSync(fontDir).filter(f => f.endsWith(".ttf") || f.endsWith(".otf"));
      }
      
      for (const box of boxes) {
        if (box.svgContent) {
          try {
            doc.save();
            doc.translate(box.x, box.y);
            
            if (box.rotated) {
              doc.rotate(90, { origin: [box.w / 2, box.w / 2] });
            }

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
        } else if (box.imageContent) {
          // RENDERING IMMAGINE RASTER (v1.5.0)
          try {
            doc.save();
            const imgBuffer = Buffer.from(box.imageContent, "base64");
            
            doc.image(imgBuffer, box.x, box.y, {
              width: box.w,
              height: box.h,
              fit: [box.w, box.h],
              align: "center",
              valign: "center"
            });

            doc.restore();
          } catch (imgErr) {
            console.error("IMAGE RENDER ERROR:", imgErr);
            doc.rect(box.x, box.y, box.w, box.h).stroke();
          }
        } else if (box.textContent) {
          // RENDERING TESTO DINAMICO (v1.4.0)
          try {
            doc.save();
            
            // RICERCA FONT INTELLIGENTE
            let fontPath = null;
            const targetFont = (box.fontName || "").toLowerCase().trim();
            
            // 1. Cerca match esatto o parziale nei file disponibili
            const match = availableFonts.find(f => {
              const baseName = f.toLowerCase().split(".")[0];
              return targetFont.includes(baseName) || baseName.includes(targetFont);
            });

            if (match) {
              fontPath = path.join(fontDir, match);
            } else {
              // 2. Fallback su Mabook se esiste
              const defaultMabook = availableFonts.find(f => f.toLowerCase().includes("mabook"));
              if (defaultMabook) fontPath = path.join(fontDir, defaultMabook);
            }
            
            if (fontPath && fs.existsSync(fontPath)) {
              doc.font(fontPath);
            } else {
              doc.font("Helvetica-Bold"); // Fallback estremo di sistema
            }

            // Scelta Colore (HEX o Nomi)
            let color = "white"; 
            const c = (box.fontColor || "").trim();
            if (c.startsWith("#")) {
              color = c;
            } else if (c.toLowerCase().includes("nero") || c.toLowerCase().includes("black")) {
              color = "black";
            } else if (c.toLowerCase().includes("bianco") || c.toLowerCase().includes("white")) {
              color = "white";
            } else if (c.length === 6 && /^[0-9A-F]{6}$/i.test(c)) {
              color = `#${c}`;
            }
            
            doc.fillColor(color);

            // Calcolo Dimensione Testo (adattivo per stare nel box)
            const fontSize = box.heightMm < 40 ? 14 : 22; 
            doc.fontSize(fontSize);

            // Centratura Testo nel Box (80x100mm)
            doc.text(box.textContent, box.x, box.y + (box.h / 2) - (fontSize / 2), {
              width: box.w,
              align: "center",
              lineBreak: true
            });

            doc.restore();
          } catch (txtErr) {
            console.error("TEXT RENDER ERROR:", txtErr);
            doc.rect(box.x, box.y, box.w, box.h).stroke();
          }
        } else {
          doc.rect(box.x, box.y, box.w, box.h).stroke();
        }

        // Label sotto il pezzo
        doc.fillColor("black")
           .font("Helvetica") 
           .fontSize(8)
           .text(`${box.orderName}${box.rotated ? ' (R)' : ''}`, box.x, box.y + box.h + 2, {
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
