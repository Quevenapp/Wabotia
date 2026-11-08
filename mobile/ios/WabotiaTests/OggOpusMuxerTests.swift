import XCTest
@testable import Wabotia

final class OggOpusMuxerTests: XCTestCase {
    /// Pacote Opus sintético: TOC CELT 20 ms (config 31), code 0 → 960 amostras; corpo com `size - 1` bytes.
    private func packet(size: Int, toc: UInt8 = 0xF8, fill: UInt8 = 0xAB) -> Data {
        var d = Data([toc])
        d.append(Data(repeating: fill, count: max(0, size - 1)))
        return d
    }

    /// Divide um fluxo Ogg em páginas (cabeçalho + corpo) e valida o CRC de cada uma.
    private struct OggPage {
        var flags: UInt8
        var granule: Int64
        var serial: UInt32
        var sequence: UInt32
        var crc: UInt32
        var lacing: [UInt8]
        var body: Data
        var raw: Data
    }

    private func pages(_ ogg: Data) throws -> [OggPage] {
        var result: [OggPage] = []
        var o = 0
        while o < ogg.count {
            XCTAssertEqual(Array(ogg[o..<o + 4]), [0x4f, 0x67, 0x67, 0x53], "capture pattern OggS")
            XCTAssertEqual(ogg[o + 4], 0, "versão 0")
            let flags = ogg[o + 5]
            let granule = OggOpusMuxer.readInt64LE(ogg, o + 6)
            let serial = OggOpusMuxer.readUInt32LE(ogg, o + 14)
            let sequence = OggOpusMuxer.readUInt32LE(ogg, o + 18)
            let crc = OggOpusMuxer.readUInt32LE(ogg, o + 22)
            let segments = Int(ogg[o + 26])
            let lacing = Array(ogg[o + 27..<o + 27 + segments])
            let bodySize = lacing.reduce(0) { $0 + Int($1) }
            let headerSize = 27 + segments
            let raw = ogg[o..<o + headerSize + bodySize]
            let body = ogg[o + headerSize..<o + headerSize + bodySize]
            result.append(OggPage(flags: flags, granule: granule, serial: serial, sequence: sequence, crc: crc, lacing: lacing, body: Data(body), raw: Data(raw)))
            o += headerSize + bodySize
        }
        return result
    }

    private func verifyCRC(_ page: OggPage) {
        var zeroed = page.raw
        zeroed.replaceSubrange(22..<26, with: [0, 0, 0, 0])
        XCTAssertEqual(OggOpusMuxer.crc32(zeroed), page.crc, "CRC da página \(page.sequence)")
    }

    func testCRC32KnownValues() {
        XCTAssertEqual(OggOpusMuxer.crc32(Data()), 0)
        XCTAssertEqual(OggOpusMuxer.crc32(Data([0x00])), 0)
        XCTAssertEqual(OggOpusMuxer.crc32(Data([0x01])), 0x04c1_1db7, "tabela[1] é o polinômio")
        XCTAssertEqual(OggOpusMuxer.crc32(Data([0x80])), 0x690c_e0ee)
        XCTAssertNotEqual(OggOpusMuxer.crc32(Data("abc".utf8)), OggOpusMuxer.crc32(Data("abd".utf8)))
    }

    func testOpusPacketSamplesFromTOC() {
        XCTAssertEqual(OggOpusMuxer.opusPacketSamples(Data([0xF8])), 960)          // CELT 20 ms, 1 quadro
        XCTAssertEqual(OggOpusMuxer.opusPacketSamples(Data([0xF9])), 1920)         // 2 quadros
        XCTAssertEqual(OggOpusMuxer.opusPacketSamples(Data([0x08])), 960)          // SILK NB 20 ms
        XCTAssertEqual(OggOpusMuxer.opusPacketSamples(Data([0x00])), 480)          // SILK NB 10 ms
        XCTAssertEqual(OggOpusMuxer.opusPacketSamples(Data([0x18])), 2880)         // SILK 60 ms
        XCTAssertEqual(OggOpusMuxer.opusPacketSamples(Data([0x60])), 480)          // híbrido 10 ms (config 12)
        XCTAssertEqual(OggOpusMuxer.opusPacketSamples(Data([0xFB, 0x03])), 2880)   // code 3, 3 quadros de 20 ms
        XCTAssertEqual(OggOpusMuxer.opusPacketSamples(Data()), 0)
    }

    func testHeadersAndPageLayout() throws {
        let packets = (0..<5).map { packet(size: 40 + $0) }
        let ogg = OggOpusMuxer.ogg(packets: packets, channels: 1, preSkip: 312, inputSampleRate: 48000, validFrames: nil, serial: 0x1234_5678)
        let p = try pages(ogg)
        XCTAssertEqual(p.count, 3, "OpusHead, OpusTags e uma página de áudio")
        p.forEach(verifyCRC)
        XCTAssertTrue(p.allSatisfy { $0.serial == 0x1234_5678 })
        XCTAssertEqual(p.map(\.sequence), [0, 1, 2])

        // OpusHead: BOS, granule 0, 19 bytes.
        XCTAssertEqual(p[0].flags, 0x02)
        XCTAssertEqual(p[0].granule, 0)
        XCTAssertEqual(p[0].lacing, [19])
        XCTAssertEqual(String(data: p[0].body.prefix(8), encoding: .ascii), "OpusHead")
        XCTAssertEqual(p[0].body[8], 1, "versão")
        XCTAssertEqual(p[0].body[9], 1, "canais")
        XCTAssertEqual(Int(p[0].body[10]) | (Int(p[0].body[11]) << 8), 312, "pré-skip")
        XCTAssertEqual(OggOpusMuxer.readUInt32LE(p[0].body, 12), 48000)
        XCTAssertEqual(p[0].body[16], 0); XCTAssertEqual(p[0].body[17], 0) // ganho
        XCTAssertEqual(p[0].body[18], 0, "família de mapeamento")

        // OpusTags: sem flags, granule 0.
        XCTAssertEqual(p[1].flags, 0x00)
        XCTAssertEqual(p[1].granule, 0)
        XCTAssertEqual(String(data: p[1].body.prefix(8), encoding: .ascii), "OpusTags")
        let vendorLength = Int(OggOpusMuxer.readUInt32LE(p[1].body, 8))
        XCTAssertEqual(OggOpusMuxer.readUInt32LE(p[1].body, 12 + vendorLength), 0, "sem comentários")

        // Áudio: EOS, um segmento por pacote (<255 bytes), granule = soma de amostras.
        XCTAssertEqual(p[2].flags, 0x04)
        XCTAssertEqual(p[2].lacing, [40, 41, 42, 43, 44])
        XCTAssertEqual(p[2].granule, 5 * 960)
        XCTAssertEqual(p[2].body, packets.reduce(Data()) { $0 + $1 })
    }

    func testLacingForPacketsOf255AndLarger() throws {
        let packets = [packet(size: 255), packet(size: 300), packet(size: 510)]
        let ogg = OggOpusMuxer.ogg(packets: packets, channels: 1, preSkip: 312, serial: 7)
        let p = try pages(ogg)
        p.forEach(verifyCRC)
        XCTAssertEqual(p[2].lacing, [255, 0, 255, 45, 255, 255, 0])
        XCTAssertEqual(p[2].body.count, 255 + 300 + 510)
    }

    func testPaginationGranulesAndEndTrimming() throws {
        let packets = (0..<120).map { _ in packet(size: 60) }
        let total = Int64(120 * 960)
        let valid = total - 312 - 500 // sobras de padding no fim devem ser cortadas
        let ogg = OggOpusMuxer.ogg(packets: packets, channels: 1, preSkip: 312, validFrames: valid, serial: 9, packetsPerPage: 50)
        let p = try pages(ogg)
        p.forEach(verifyCRC)
        XCTAssertEqual(p.count, 2 + 3, "50 + 50 + 20 pacotes")
        XCTAssertEqual(p[2].granule, 50 * 960)
        XCTAssertEqual(p[3].granule, 100 * 960)
        XCTAssertEqual(p[4].granule, 312 + valid, "granule final = pré-skip + quadros válidos")
        XCTAssertEqual(p[2].flags, 0); XCTAssertEqual(p[3].flags, 0); XCTAssertEqual(p[4].flags, 0x04)
        XCTAssertEqual(p[2].lacing.count, 50); XCTAssertEqual(p[4].lacing.count, 20)
        XCTAssertEqual(p.map(\.sequence), [0, 1, 2, 3, 4])
    }

    func testSegmentLimitPerPage() throws {
        // 100 pacotes de 600 bytes = 3 segmentos cada; com limite de 255 segmentos cabem 85 por página.
        let packets = (0..<100).map { _ in packet(size: 600) }
        let ogg = OggOpusMuxer.ogg(packets: packets, channels: 1, preSkip: 312, serial: 3, packetsPerPage: 1000)
        let p = try pages(ogg)
        p.forEach(verifyCRC)
        XCTAssertEqual(p.count, 4)
        XCTAssertEqual(p[2].lacing.count, 255)
        XCTAssertEqual(p[3].lacing.count, 45)
        XCTAssertEqual(p[3].granule, 100 * 960)
    }

    func testParseSyntheticCAF() throws {
        // Monta um CAF mínimo: cabeçalho, desc (opus 48 kHz mono, 960 quadros/pacote), pakt e data.
        func be32(_ v: UInt32) -> [UInt8] { [UInt8(v >> 24), UInt8((v >> 16) & 0xff), UInt8((v >> 8) & 0xff), UInt8(v & 0xff)] }
        func be64(_ v: Int64) -> [UInt8] { let u = UInt64(bitPattern: v); return (0..<8).reversed().map { UInt8((u >> (UInt64($0) * 8)) & 0xff) } }
        let packets = [packet(size: 10), packet(size: 200), packet(size: 130)]
        var caf: [UInt8] = Array("caff".utf8) + [0, 1, 0, 0]
        var desc: [UInt8] = be64(Int64(bitPattern: 48000.0.bitPattern)) + Array("opus".utf8) + be32(0) + be32(0) + be32(960) + be32(1) + be32(0)
        caf += Array("desc".utf8) + be64(Int64(desc.count)); caf += desc; desc = []
        var pakt: [UInt8] = be64(3) + be64(3 * 960 - 312) + be32(312) + be32(0)
        pakt += [10]                 // 10
        pakt += [0x81, 0x48]         // 200 = (1<<7) | 72
        pakt += [0x81, 0x02]         // 130 = (1<<7) | 2
        caf += Array("pakt".utf8) + be64(Int64(pakt.count)) + pakt
        var data: [UInt8] = [0, 0, 0, 0]
        for p in packets { data += [UInt8](p) }
        caf += Array("data".utf8) + be64(Int64(data.count)) + data

        let parsed = try OggOpusMuxer.parseCAF(Data(caf))
        XCTAssertEqual(parsed.sampleRate, 48000)
        XCTAssertEqual(parsed.channels, 1)
        XCTAssertEqual(parsed.framesPerPacket, 960)
        XCTAssertEqual(parsed.primingFrames, 312)
        XCTAssertEqual(parsed.validFrames, 3 * 960 - 312)
        XCTAssertEqual(parsed.packets, packets)

        // Fim a fim: converte para Ogg e confere cabeçalhos e granule final.
        let caf2 = FileManager.default.temporaryDirectory.appendingPathComponent("muxer-test.caf")
        let ogg2 = FileManager.default.temporaryDirectory.appendingPathComponent("muxer-test.ogg")
        try Data(caf).write(to: caf2)
        try OggOpusMuxer.convert(cafURL: caf2, to: ogg2)
        let p = try pages(try Data(contentsOf: ogg2))
        p.forEach(verifyCRC)
        XCTAssertEqual(p.count, 3)
        XCTAssertEqual(p[2].granule, 3 * 960, "pré-skip 312 + quadros válidos")
        XCTAssertEqual(p[2].lacing, [10, 200, 130])
        try? FileManager.default.removeItem(at: caf2)
        try? FileManager.default.removeItem(at: ogg2)
    }

    func testRejectsNonCAFAndNonOpus() {
        XCTAssertThrowsError(try OggOpusMuxer.parseCAF(Data("RIFF....".utf8)))
        var caf: [UInt8] = Array("caff".utf8) + [0, 1, 0, 0]
        let desc: [UInt8] = [UInt8](repeating: 0, count: 8) + Array("aac ".utf8) + [UInt8](repeating: 0, count: 20)
        caf += Array("desc".utf8) + [0, 0, 0, 0, 0, 0, 0, UInt8(desc.count)] + desc
        XCTAssertThrowsError(try OggOpusMuxer.parseCAF(Data(caf)))
    }
}
