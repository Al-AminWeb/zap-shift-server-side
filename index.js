const {ObjectId} = require('mongodb');
const express = require('express');
const {MongoClient, ServerApiVersion} = require('mongodb');
const cors = require('cors');
const dotenv = require('dotenv');
const app = express();
dotenv.config();
const port = process.env.PORT || 3000;

const stripe = require('stripe')(process.env.PAYMENT_GATEWAY_KEY);

app.use(cors());
app.use(express.json());


const uri = `mongodb+srv://${process.env.DB_USER}:${process.env.DB_PASS}@cluster0.9c3lw.mongodb.net/?retryWrites=true&w=majority&appName=Cluster0`;

const client = new MongoClient(uri, {
    serverApi: {
        version: ServerApiVersion.v1,
        strict: true,
        deprecationErrors: true,
    }
});

async function run() {
    try {
        const db = client.db('parcelDB');
        const parcelCollection = db.collection('parcels');
        const paymentCollection = db.collection('payments');

        app.get('/parcels', async (req, res) => {
            const parcels = await parcelCollection.find().toArray();
            res.send(parcels);
        })

        /* ----------  POST a new parcel  ---------- */
        app.post('/parcels', async (req, res) => {
            try {
                /* ── 1. Basic validation ── */
                const required = [
                    'type',
                    'title',
                    'senderName',
                    'senderContact',
                    'senderEmail',
                    'senderRegion',
                    'senderCenter',
                    'senderAddress',
                    'pickupInstruction',
                    'receiverName',
                    'receiverContact',
                    'receiverRegion',
                    'receiverCenter',
                    'receiverAddress',
                    'deliveryInstruction',
                    'createdBy',
                    'cost'
                ];
                const missing = required.filter(k => !req.body?.[k]);
                if (missing.length) {
                    return res
                        .status(400)
                        .json({error: `Missing required fields: ${missing.join(', ')}`});
                }

                /* ── 2. Attach server‑trusted timestamps ── */
                const now = Date.now();                      //Unix (ms)
                const parcelDoc = {
                    ...req.body,
                    createdAtUnix: now,
                    createdAtISO: new Date(now).toISOString()
                };

                /* ── 3. Save to MongoDB ── */
                const result = await parcelCollection.insertOne(parcelDoc);

                /* ── 4. Respond ── */
                res.status(201).json({
                    message: 'Parcel saved successfully.',
                    insertedId: result.insertedId
                });
            } catch (err) {
                console.error('❌  Failed to save parcel:', err);
                res
                    .status(500)
                    .json({error: 'Something went wrong while saving the parcel.'});
            }
        });

        /* ----------  GET /parcels — all or by user, sorted by ISO date ---------- */
        app.get('/parcels', async (req, res) => {
            try {
                const filter = {};

                // Optional: filter by user e‑mail via createdBy field
                if (req.query.createdBy) {
                    filter.createdBy = req.query.createdBy;
                }

                // Fetch parcels sorted by createdAtISO (latest first)
                const parcels = await parcelCollection
                    .find(filter)
                    .sort({createdAtISO: -1})  // ISO strings sort chronologically
                    .toArray();

                res.json(parcels);
            } catch (err) {
                console.error('❌ Error fetching parcels:', err);
                res.status(500).json({error: 'Failed to fetch parcel data.'});
            }
        });

        app.get('/parcels/:id', async (req, res) => {
            try {
                const id = req.params.id;
                // 2️⃣ Query MongoDB by _id
                const parcel = await parcelCollection.findOne({_id: new ObjectId(id)});

                // 3️⃣ Handle not found
                if (!parcel) {
                    return res.status(404).json({error: 'Parcel not found.'});
                }

                // 4️⃣ Success
                res.json(parcel);
            } catch (err) {
                console.error('❌ Error fetching parcel by ID:', err);
                res.status(500).json({error: 'Failed to fetch parcel.'});
            }
        });

        app.delete('/parcels/:id', async (req, res) => {
            try {
                const id = req.params.id;

                // Validate ObjectId
                if (!ObjectId.isValid(id)) {
                    return res.status(400).json({error: 'Invalid parcel ID.'});
                }

                const result = await parcelCollection.deleteOne({_id: new ObjectId(id)});

                if (result.deletedCount === 0) {
                    return res.status(404).json({error: 'Parcel not found.'});
                }

                res.json({message: 'Parcel deleted successfully.'});
            } catch (err) {
                console.error('❌ Error deleting parcel:', err);
                res.status(500).json({error: 'Failed to delete parcel.'});
            }
        });

        app.post('/payments', async (req, res) => {
            try {
                const { parcelId, amount, paymentMethod, transactionId  } = req.body;

                if (!ObjectId.isValid(parcelId)) {
                    return res.status(400).json({ error: 'Invalid parcelId.' });
                }

                // ✅ Fetch parcel to get user info (createdBy)
                const parcel = await parcelCollection.findOne({ _id: new ObjectId(parcelId) });
                if (!parcel) return res.status(404).json({ error: 'Parcel not found.' });

                if (parcel.paymentStatus === 'Paid') {
                    return res.status(409).json({ error: 'Parcel already marked as Paid.' });
                }

                const now = Date.now();
                const paymentDoc = {
                    parcelId: new ObjectId(parcelId),
                    amount,
                    paymentMethod,
                    txId: transactionId  || null,
                    status: 'Paid',
                    createdAtISO: new Date(now).toISOString(),
                    createdAtUnix: now,
                    createdBy: parcel.createdBy || null   // ✅ ADD THIS LINE
                };

                const payResult = await paymentCollection.insertOne(paymentDoc);

                await parcelCollection.updateOne(
                    { _id: new ObjectId(parcelId) },
                    {
                        $set: {
                            paymentStatus: 'Paid',
                            paymentAtISO: paymentDoc.createdAtISO,
                            paymentAtUnix: paymentDoc.createdAtUnix,
                            paymentId: payResult.insertedId
                        }
                    }
                );

                res.status(201).json({
                    message: 'Payment recorded & parcel marked as Paid.',
                    paymentId: payResult.insertedId
                });

            } catch (err) {
                console.error('❌ Error posting payment:', err);
                res.status(500).json({ error: 'Failed to record payment.' });
            }
        });


        app.get('/payments', async (req, res) => {
            try {
                const filter = {};
                if (req.query.createdBy) filter.createdBy = req.query.createdBy;

                const payments = await paymentCollection
                    .find(filter)
                    .sort({ createdAtISO: -1 })    // newest → oldest
                    .toArray();

                res.json(payments);
            } catch (err) {
                console.error('❌ Error fetching payments:', err);
                res.status(500).json({ error: 'Failed to load payment history.' });
            }
        });

        app.post('/create-payment-intent', async (req, res) => {
            const amountInCents = req.body.amountInCents;
            try {
                const paymentIntent = await stripe.paymentIntents.create({
                    amount: amountInCents,
                    currency: 'usd',
                    payment_method_types: ['card'],
                });
                res.json({clientSecret: paymentIntent.client_secret});
            } catch (err) {
                res.status(500).json({error: err.message});
            }
        })

        await client.db("admin").command({ping: 1});
        console.log("Pinged your deployment. You successfully connected to MongoDB!");
    } finally {
    }
}

run().catch(console.dir);


app.get('/', (req, res) => {
    res.send('zap shift server-side');
})

app.listen(port, () => {
    console.log(`Listening on port ${port}`);
})