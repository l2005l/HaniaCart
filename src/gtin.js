// Barcodes are compared as GTIN-14: EAN-13 / UPC-12 / EAN-8 padded with zeros. '' when it is not a barcode.
export function gtin14(v) { const d = String(v == null ? '' : v).replace(/\D/g, ''); return d.length >= 8 && d.length <= 14 ? d.padStart(14, '0') : ''; }
