export const MAX_DOCUMENTS = 10;
export const MAX_DOCUMENT_BYTES = 5 * 1024 * 1024;
export const MAX_DOCUMENT_PAGES = 100;

export const formatEnvelopeNumber = number => String(number).padStart(6, '0');
export const formatDocumentNumber = (envelopeNumber, position) => envelopeNumber + String(position).padStart(2, '0');
