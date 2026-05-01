const request = require('supertest');
const app = require('./server');
const db = require('./database');

describe('Ironing API Endpoints', () => {
  let personnelId;
  let jobId;
  let planchadoServiceId;

  beforeAll((done) => {
    // Wait for initDb to complete, then clear tables
    setTimeout(() => {
      db.serialize(() => {
        db.run('DELETE FROM order_items');
        db.run('DELETE FROM ironing_jobs');
        db.run('DELETE FROM orders');
        db.run('DELETE FROM ironing_personnel');
        db.run('DELETE FROM daily_ironing_limits');
        db.run('DELETE FROM daily_ironing_audit', done);
      });
    }, 500);
  });

  afterAll((done) => {
    db.close(done);
  });

  describe('Personnel Management', () => {
    it('should create new ironing personnel', async () => {
      const res = await request(app)
        .post('/ironing-personnel')
        .send({
          nombre: 'Juan',
          apellido: 'Perez',
          documento: Date.now().toString(),
          tarifa: 5.5
        });
      
      if (res.statusCode !== 201) console.log('ERROR:', res.body);
      
      expect(res.statusCode).toBe(201);
      expect(res.body).toHaveProperty('id');
      expect(res.body.nombre).toBe('Juan');
      expect(res.body.activo).toBe(true);
      personnelId = res.body.id;
    });

    it('should fail if required fields are missing', async () => {
      const res = await request(app)
        .post('/ironing-personnel')
        .send({ nombre: 'Ana' });
      
      expect(res.statusCode).toBe(400);
      expect(res.body).toHaveProperty('error');
    });

    it('should get all personnel', async () => {
      const res = await request(app).get('/ironing-personnel');
      expect(res.statusCode).toBe(200);
      expect(Array.isArray(res.body)).toBe(true);
      expect(res.body.length).toBeGreaterThan(0);
    });
  });

  describe('Orders -> Ironing Jobs Integration', () => {
    it('should create an order with ironing breakdown and persist an ironing job with piezas_total', async () => {
      const servicesRes = await request(app).get('/services');
      expect(servicesRes.statusCode).toBe(200);
      const services = servicesRes.body;
      expect(Array.isArray(services)).toBe(true);
      const planchado = services.find(s => s.categoria === 'Planchado') ?? services[0];
      expect(planchado).toBeTruthy();
      planchadoServiceId = planchado.id;

      const orderRes = await request(app)
        .post('/orders')
        .send({
          cliente: 'Cliente Docena',
          telefono: '1111111111',
          express: false,
          metodo_pago: 'Efectivo',
          total: 50,
          fecha_entrega: '2026-04-01',
          fecha_entrega_tz: 'America/Mexico_City',
          items: [
            {
              service_id: planchadoServiceId,
              cantidad: 1,
              precio: 50
            }
          ],
          ironing: {
            pieces_total: 12,
            generated_at_iso: '2026-04-01T00:00:00.000Z',
            breakdown: [
              {
                service_id: planchadoServiceId,
                service_nombre: planchado.nombre,
                tipo_orden: 'DOCENA_COMPLETA',
                unidades: 1,
                piezas_calculadas: 12,
                piezas_finales: 12,
                override: false,
                prenda_ids: ['tmp_2026-04-01T00:00:00.000Z_' + planchadoServiceId + '_1']
              }
            ]
          }
        });

      expect(orderRes.statusCode).toBe(201);
      expect(orderRes.body).toHaveProperty('orderId');
      const orderId = orderRes.body.orderId;

      const jobsRes = await request(app).get('/ironing-jobs');
      expect(jobsRes.statusCode).toBe(200);
      expect(Array.isArray(jobsRes.body)).toBe(true);
      expect(jobsRes.body.length).toBeGreaterThan(0);

      const created = jobsRes.body.find(j => j.order_id === orderId) ?? jobsRes.body[0];
      expect(created.cantidad).toBe(12);
      expect(created.breakdown_json).toBeTruthy();
      const parsed = JSON.parse(created.breakdown_json);
      expect(parsed.pieces_total).toBe(12);
      expect(Array.isArray(parsed.breakdown)).toBe(true);
      expect(parsed.breakdown[0].tipo_orden).toBe('DOCENA_COMPLETA');
    });
  });

  describe('Jobs Management', () => {
    it('should create a new job', async () => {
      const res = await request(app)
        .post('/ironing-jobs')
        .send({
          nombre_cliente: 'Maria Lopez',
          cantidad: 10,
          fecha_entrega: '2026-04-01'
        });
      
      expect(res.statusCode).toBe(201);
      expect(res.body).toHaveProperty('id');
      expect(res.body.status).toBe('En Espera');
      jobId = res.body.id;
    });

    it('should assign a job to personnel', async () => {
      const res = await request(app)
        .put(`/ironing-jobs/${jobId}/assign`)
        .send({ asignado_id: personnelId });
      
      expect(res.statusCode).toBe(200);
      expect(res.body.success).toBe(true);
    });

    it('should complete a job', async () => {
      const res = await request(app).put(`/ironing-jobs/${jobId}/complete`);
      expect(res.statusCode).toBe(200);
      expect(res.body.success).toBe(true);
    });
  });

  describe('Payments & Reports', () => {
    it('should return payments for completed jobs', async () => {
      const res = await request(app)
        .get('/ironing-payments')
        .query({ personnel_id: personnelId });
      
      expect(res.statusCode).toBe(200);
      expect(Array.isArray(res.body)).toBe(true);
      expect(res.body.length).toBeGreaterThan(0);
      
      const payment = res.body[0];
      expect(payment.pago_total).toBe(55); // 10 pieces * 5.5 rate
      expect(payment.personnel_id).toBe(personnelId);
    });
  });

  describe('Daily Limits API', () => {
    let limitId;
    const testDate = '2026-05-15';

    it('should create a daily limit', async () => {
      const res = await request(app)
        .post('/daily-limits')
        .send({ date_string: testDate, max_pieces: 100 });
      
      expect(res.statusCode).toBe(201);
      expect(res.body).toHaveProperty('id');
      expect(res.body.date_string).toBe(testDate);
      expect(res.body.max_pieces).toBe(100);
      expect(res.body.accumulated_pieces).toBe(0);
      limitId = res.body.id;
    });

    it('should retrieve daily limit by date', async () => {
      const res = await request(app).get(`/daily-limits?date=${testDate}`);
      expect(res.statusCode).toBe(200);
      expect(Array.isArray(res.body)).toBe(true);
      expect(res.body[0].max_pieces).toBe(100);
    });

    it('should successfully add pieces within limit', async () => {
      const res = await request(app)
        .post('/daily-limits/add-pieces')
        .send({ date_string: testDate, pieces: 40 });
      
      expect(res.statusCode).toBe(200);
      expect(res.body.success).toBe(true);
      expect(res.body.accumulated_pieces).toBe(40);
    });

    it('should block adding pieces if limit exceeded', async () => {
      const res = await request(app)
        .post('/daily-limits/add-pieces')
        .send({ date_string: testDate, pieces: 70 }); // 40 + 70 = 110 > 100
      
      expect(res.statusCode).toBe(400);
      expect(res.body.error).toContain('Excede el límite diario');
    });

    it('should allow update to higher limit', async () => {
      const res = await request(app)
        .put(`/daily-limits/${limitId}`)
        .send({ max_pieces: 150 });
      
      expect(res.statusCode).toBe(200);
      expect(res.body.success).toBe(true);
    });

    it('should allow adding pieces after limit increased', async () => {
      const res = await request(app)
        .post('/daily-limits/add-pieces')
        .send({ date_string: testDate, pieces: 70 }); // 40 + 70 = 110 <= 150
      
      expect(res.statusCode).toBe(200);
      expect(res.body.success).toBe(true);
      expect(res.body.accumulated_pieces).toBe(110);
    });
  });
});
